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

function sameIdentity(book, entry) {
  return normalizeTitle(book.title) === normalizeTitle(entry.title)
    && normalizeAuthorName(book.author) === normalizeAuthorName(entry.author);
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

async function existingBooks(db, entries) {
  const rows = await db.book.findMany({
    where: { isbn: { in: entries.map(entry => entry.isbn) } },
    select: { id: true, isbn: true, title: true, author: true },
  });
  return new Map(rows.map(row => [row.isbn, row]));
}

export async function inspectLaunchCatalog(db, entries) {
  const existingByIsbn = await existingBooks(db, entries);
  const conflicts = [];
  let matched = 0;
  for (const entry of entries) {
    const existing = existingByIsbn.get(entry.isbn);
    if (!existing) {
      if (entry.pinnedIsbn13) conflicts.push({ key: entry.key, isbn: entry.isbn, reason: 'pinned_isbn_missing' });
      continue;
    }
    if (!sameIdentity(existing, entry)) {
      conflicts.push({ key: entry.key, isbn: entry.isbn, reason: 'identity_conflict', existingTitle: existing.title, existingAuthor: existing.author });
    } else {
      matched++;
    }
  }
  return {
    sourceEntries: entries.length,
    matched,
    created: entries.length - matched - conflicts.length,
    updated: 0,
    conflicts,
    invalidEntries: 0,
  };
}

async function createIfMissing(db, entry) {
  return serializable(db, async tx => {
    const existing = await tx.book.findUnique({
      where: { isbn: entry.isbn },
      select: { id: true, title: true, author: true },
    });
    if (existing) {
      if (!sameIdentity(existing, entry)) {
        throw new LaunchCatalogError('identity_conflict', `${entry.key}: existing ISBN ${entry.isbn} belongs to a different title or author`);
      }
      return 'matched';
    }
    if (entry.pinnedIsbn13) {
      throw new LaunchCatalogError('pinned_isbn_missing', `${entry.key}: pinned ISBN ${entry.isbn} must already exist`);
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
  const inspection = await inspectLaunchCatalog(db, entries);
  if (!apply) return { ...inspection, conflicts: inspection.conflicts.length };
  if (inspection.conflicts.length) {
    throw new LaunchCatalogError('identity_conflict', 'Launch import found existing ISBN/title identity conflicts', inspection.conflicts);
  }

  let matched = 0;
  let created = 0;
  for (const entry of entries) {
    const outcome = await createIfMissing(db, entry);
    if (outcome === 'matched') matched++;
    else created++;
  }
  return {
    sourceEntries: entries.length,
    matched,
    created,
    updated: 0,
    conflicts: 0,
    invalidEntries: 0,
  };
}
