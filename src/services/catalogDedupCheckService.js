import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { validateDiscoverArtifact } from '../../scripts/catalog/discover.js';
import { normalizeAuthorName, normalizeIsbn10ToIsbn13, normalizeIsbn13, normalizeTitle } from '../../scripts/catalog/normalize.js';
import { workIdentity } from '../../scripts/catalog/work-identity.js';

export const OPEN_LIBRARY_WORK_KEY_PATTERN = /^\/works\/OL\d+W$/;

const WRITE_METHODS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

export function isValidOpenLibraryWorkKey(value) {
  return typeof value === 'string' && value.length > 0 && OPEN_LIBRARY_WORK_KEY_PATTERN.test(value);
}

export function normalizeCandidateIsbns(candidate) {
  const rawValues = [];
  if (Array.isArray(candidate.isbns)) rawValues.push(...candidate.isbns);
  if (typeof candidate.isbn === 'string') rawValues.push(candidate.isbn);
  const normalized = new Set();
  for (const value of rawValues) {
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      normalized.add(normalizeIsbn13(value));
      continue;
    } catch {
      try {
        normalized.add(normalizeIsbn10ToIsbn13(value));
      } catch {
        // Invalid identifiers are ignored for matching.
      }
    }
  }
  return normalized;
}

export function candidateTitleAuthorKey(candidate) {
  if (typeof candidate.primaryAuthor !== 'string' || !candidate.primaryAuthor.trim()) return null;
  if (typeof candidate.title !== 'string' || !candidate.title.trim()) return null;
  return `${normalizeTitle(candidate.title)}\u0000${normalizeAuthorName(candidate.primaryAuthor)}`;
}

function uniqueSortedIds(ids) {
  return [...new Set(ids)].sort();
}

function matchIdsFromIsbns(isbns, byIsbn) {
  const matched = new Set();
  for (const isbn of isbns) {
    for (const bookId of byIsbn.get(isbn) ?? []) matched.add(bookId);
  }
  return matched;
}

function classifyCandidate(candidate, indexes) {
  const workKeyMatches = isValidOpenLibraryWorkKey(candidate.workKey)
    ? new Set(indexes.byWorkKey.get(candidate.workKey) ?? [])
    : new Set();
  const isbnMatches = matchIdsFromIsbns(normalizeCandidateIsbns(candidate), indexes.byIsbn);
  const titleAuthorKey = candidateTitleAuthorKey(candidate);
  const titleAuthorMatches = titleAuthorKey
    ? new Set(indexes.byTitleAuthor.get(titleAuthorKey) ?? [])
    : new Set();

  const methods = [
    ['openLibraryWorkKey', workKeyMatches],
    ['isbn', isbnMatches],
    ['titleAuthor', titleAuthorMatches],
  ].filter(([, matches]) => matches.size > 0);

  if (!methods.length) {
    return {
      workKey: candidate.workKey,
      title: candidate.title,
      status: 'new',
      matchedBookIds: [],
      matchedBy: null,
    };
  }

  const primary = methods[0];
  const matchedBy = primary[0];
  const primaryMatches = primary[1];
  const union = new Set();
  for (const [, matches] of methods) {
    for (const bookId of matches) union.add(bookId);
  }

  const crossMethodConflict = methods.some(([, matches]) => {
    for (const bookId of matches) {
      if (!primaryMatches.has(bookId)) return true;
    }
    return false;
  });

  const ambiguous = primaryMatches.size > 1 || crossMethodConflict;
  const matchedBookIds = ambiguous ? uniqueSortedIds(union) : [uniqueSortedIds(primaryMatches)[0]];

  return {
    workKey: candidate.workKey,
    title: candidate.title,
    status: ambiguous ? 'ambiguous' : 'existing',
    matchedBookIds,
    matchedBy,
  };
}

export async function buildBookMatchIndexes(db) {
  const books = await db.book.findMany({
    select: {
      id: true,
      isbn: true,
      title: true,
      author: true,
      openLibraryWorkKey: true,
    },
  });

  const byWorkKey = new Map();
  const byIsbn = new Map();
  const byTitleAuthor = new Map();

  for (const book of books) {
    if (isValidOpenLibraryWorkKey(book.openLibraryWorkKey)) {
      const list = byWorkKey.get(book.openLibraryWorkKey) ?? [];
      list.push(book.id);
      byWorkKey.set(book.openLibraryWorkKey, list);
    }
    if (book.isbn) {
      const list = byIsbn.get(book.isbn) ?? [];
      list.push(book.id);
      byIsbn.set(book.isbn, list);
    }
    const identity = workIdentity(book);
    const list = byTitleAuthor.get(identity) ?? [];
    list.push(book.id);
    byTitleAuthor.set(identity, list);
  }

  return { byWorkKey, byIsbn, byTitleAuthor };
}

export async function checkCatalogDuplicates(db, candidates) {
  const indexes = await buildBookMatchIndexes(db);
  const results = candidates.map(candidate => classifyCandidate(candidate, indexes));
  const summary = { new: 0, existing: 0, ambiguous: 0 };
  for (const result of results) summary[result.status] += 1;
  return { results, summary };
}

function stripCandidateEnrichment(candidate) {
  const { isbns: _isbns, isbn: _isbn, primaryAuthor: _primaryAuthor, ...core } = candidate;
  return core;
}

export async function loadDiscoverCandidates(inputPath) {
  const resolved = resolve(inputPath);
  let artifact;
  try {
    artifact = JSON.parse(await fs.readFile(resolved, 'utf8'));
  } catch (cause) {
    throw new Error(`Unable to read discover input ${resolved}: ${cause.message}`);
  }
  validateDiscoverArtifact({
    ...artifact,
    candidates: artifact.candidates.map(stripCandidateEnrichment),
  });
  return artifact.candidates;
}

export async function writeDedupReport(outputPath, results) {
  const resolved = resolve(outputPath);
  await fs.mkdir(dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  const lines = results.map(result => `${JSON.stringify(result)}\n`).join('');
  try {
    await fs.writeFile(temporary, lines, 'utf8');
    await fs.rename(temporary, resolved);
  } catch (cause) {
    await fs.rm(temporary, { force: true });
    throw cause;
  }
}

export async function readDedupReport(inputPath) {
  const resolved = resolve(inputPath);
  const results = [];
  const lines = createInterface({ input: createReadStream(resolved), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      results.push(JSON.parse(trimmed));
    }
  } finally {
    lines.close();
  }
  return results;
}

export function createReadOnlyDbGuard(db) {
  const guard = method => {
    throw new Error(`catalog dedup check is read-only (${method})`);
  };

  function wrap(target) {
    if (!target || typeof target !== 'object') return target;
    return new Proxy(target, {
      get(source, property, receiver) {
        if (property === '$transaction') {
          return async callback => callback(wrap(source));
        }
        if (property === '$executeRaw' || property === '$executeRawUnsafe' || property === '$queryRawUnsafe') {
          return () => guard(property);
        }
        if (WRITE_METHODS.has(property)) return () => guard(property);
        const value = Reflect.get(source, property, receiver);
        if (value && typeof value === 'object' && property !== '_client') return wrap(value);
        return typeof value === 'function' ? value.bind(source) : value;
      },
    });
  }

  return wrap(db);
}

export async function runCatalogDedupCheck({ db, inputPath, outputPath }) {
  const candidates = await loadDiscoverCandidates(inputPath);
  const { results, summary } = await checkCatalogDuplicates(db, candidates);
  await writeDedupReport(outputPath, results);
  return { results, summary, outputPath: resolve(outputPath) };
}
