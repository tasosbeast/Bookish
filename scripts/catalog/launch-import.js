import { serializable } from '../../src/lib/transaction.js';
import { CatalogContractError, validateSourceManifest } from './contracts.js';
import { normalizeAuthorName, normalizeTitle } from './normalize.js';

const LAUNCH_CATALOG_SIZE = 250;

export class LaunchCatalogError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = 'LaunchCatalogError';
    this.code = code;
    this.details = details;
  }
}

function coverUrl(isbn) {
  return `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`;
}

function titleForWorkIdentity(title) {
  const suffix = title.match(/\s*\(([^()]*)\)\s*$/);
  if (!suffix || /\b(audio|audiobook|graphic|guide|study|summary|companion|omnibus|collection|box set|movie|film|adaptation)\b/i.test(suffix[1])) {
    return normalizeTitle(title);
  }
  return normalizeTitle(title.slice(0, suffix.index));
}

function workIdentity(book) {
  return `${titleForWorkIdentity(book.title)}\u0000${normalizeAuthorName(book.author)}`;
}

function compatibleIdentity(book, entry) {
  return workIdentity(book) === workIdentity(entry);
}

export function prepareLaunchCatalog(sourceValue) {
  let source;
  try {
    source = validateSourceManifest(sourceValue);
  } catch (error) {
    if (error instanceof CatalogContractError) {
      throw new LaunchCatalogError(error.code, error.message, [error.message]);
    }
    throw error;
  }
  if (source.length !== LAUNCH_CATALOG_SIZE) {
    throw new LaunchCatalogError('invalid_source_count', `Launch catalog must contain exactly ${LAUNCH_CATALOG_SIZE} entries`);
  }

  const seen = new Set();
  return source.map(entry => {
    const isbn = entry.pinnedIsbn13 ?? entry.preferredIsbn13;
    if (!isbn) throw new LaunchCatalogError('missing_isbn', `${entry.key}: launch entries require a pinned or preferred ISBN-13`);
    if (seen.has(isbn)) throw new LaunchCatalogError('duplicate_launch_isbn', `Duplicate launch ISBN ${isbn}`);
    seen.add(isbn);
    return {
      key: entry.key,
      title: entry.title,
      author: entry.author,
      isbn,
      pinnedIsbn13: entry.pinnedIsbn13 ?? null,
      description: null,
      publicationYear: null,
      coverImageUrl: coverUrl(isbn),
    };
  });
}

async function existingBooks(db) {
  const rows = await db.book.findMany({
    select: { id: true, isbn: true, title: true, author: true },
  });
  return rows;
}

async function classifyLaunchCatalog(db, entries) {
  const existing = await existingBooks(db);
  const existingByIsbn = new Map(existing.filter(book => book.isbn).map(book => [book.isbn, book]));
  const existingByWork = new Map();
  for (const book of existing) {
    const identity = workIdentity(book);
    const matches = existingByWork.get(identity) ?? [];
    matches.push(book);
    existingByWork.set(identity, matches);
  }
  const conflicts = [];
  const claimedBookIds = new Set();
  const matches = new Map();
  let matchedExactIsbn = 0;
  let matchedExistingWork = 0;
  for (const entry of entries) {
    const exact = existingByIsbn.get(entry.isbn);
    if (exact) {
      if (!compatibleIdentity(exact, entry)) {
        conflicts.push({ key: entry.key, isbn: entry.isbn, reason: 'identity_conflict', existingTitle: exact.title, existingAuthor: exact.author });
      } else if (claimedBookIds.has(exact.id)) {
        conflicts.push({ key: entry.key, isbn: entry.isbn, reason: 'existing_book_reused', existingBookId: exact.id });
      } else {
        claimedBookIds.add(exact.id);
        matches.set(entry.key, { kind: 'exact', book: exact });
        matchedExactIsbn++;
      }
      continue;
    }
    const workMatches = existingByWork.get(workIdentity(entry)) ?? [];
    if (workMatches.length > 1) {
      conflicts.push({ key: entry.key, isbn: entry.isbn, reason: 'ambiguous_work_match', existingBookIds: workMatches.map(book => book.id) });
    } else if (workMatches.length === 1) {
      const book = workMatches[0];
      if (claimedBookIds.has(book.id)) {
        conflicts.push({ key: entry.key, isbn: entry.isbn, reason: 'existing_book_reused', existingBookId: book.id });
      } else {
        claimedBookIds.add(book.id);
        matches.set(entry.key, { kind: 'work', book });
        matchedExistingWork++;
      }
    }
  }
  const summary = {
    sourceEntries: entries.length,
    matchedExactIsbn,
    matchedExistingWork,
    created: entries.length - matchedExactIsbn - matchedExistingWork - conflicts.length,
    updated: 0,
    conflicts,
    invalidEntries: 0,
    unmappedExistingBooks: existing.filter(book => !claimedBookIds.has(book.id)),
  };
  return { summary, matches };
}

export async function inspectLaunchCatalog(db, entries) {
  const { summary } = await classifyLaunchCatalog(db, entries);
  return summary;
}

async function createIfMissing(db, entry) {
  return serializable(db, async tx => {
    const existing = await tx.book.findUnique({
      where: { isbn: entry.isbn },
      select: { id: true, title: true, author: true },
    });
    if (existing) {
      if (!compatibleIdentity(existing, entry)) {
        throw new LaunchCatalogError('identity_conflict', `${entry.key}: existing ISBN ${entry.isbn} belongs to a different title or author`);
      }
      throw new LaunchCatalogError('existing_isbn_race', `${entry.key}: ISBN ${entry.isbn} appeared after launch preflight`);
    }
    await tx.book.create({
      data: {
        title: entry.title,
        author: entry.author,
        isbn: entry.isbn,
        description: null,
        publicationYear: null,
        coverImageUrl: entry.coverImageUrl,
      },
    });
    return 'created';
  });
}

export async function importLaunchCatalog(db, sourceValue, { apply } = {}) {
  if (typeof apply !== 'boolean') throw new TypeError('apply must be true or false');
  const entries = prepareLaunchCatalog(sourceValue);
  const { summary: inspection, matches } = await classifyLaunchCatalog(db, entries);
  const report = { ...inspection, conflicts: inspection.conflicts.length };
  if (!apply) return report;
  if (inspection.conflicts.length) {
    throw new LaunchCatalogError('identity_conflict', 'Launch import found existing ISBN/title identity conflicts', inspection.conflicts);
  }

  let created = 0;
  for (const entry of entries) {
    if (matches.has(entry.key)) continue;
    await createIfMissing(db, entry);
    created++;
  }
  return {
    sourceEntries: entries.length,
    matchedExactIsbn: inspection.matchedExactIsbn,
    matchedExistingWork: inspection.matchedExistingWork,
    created,
    updated: 0,
    conflicts: 0,
    invalidEntries: 0,
    unmappedExistingBooks: inspection.unmappedExistingBooks,
  };
}
