import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import generated from '../../src/generated/prisma/index.js';
import { CatalogContractError } from './contracts.js';
import { validateDiscoverArtifact } from './discover.js';
import { enrichedArtifactForValidation } from './language-check.js';
import { normalizeIsbn10ToIsbn13, normalizeIsbn13 } from './normalize.js';
import { workIdentity } from './work-identity.js';
import { writeFileAtomic } from './atomic-write.js';

export const OPEN_LIBRARY_WORK_KEY_PATTERN = /^\/works\/OL\d+W$/;

export function isValidOpenLibraryWorkKey(value) {
  return typeof value === 'string' && value.length > 0 && OPEN_LIBRARY_WORK_KEY_PATTERN.test(value);
}

export function readOnlyDatabaseUrl(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const url = new URL(databaseUrl);
  const readOnlyFlag = '-c default_transaction_read_only=on';
  const existing = url.searchParams.get('options');
  url.searchParams.set('options', existing ? `${existing} ${readOnlyFlag}` : readOnlyFlag);
  return url.toString();
}

export function createReadOnlyDbInterface(client) {
  return {
    book: {
      findMany: (...args) => client.book.findMany(...args),
    },
    $disconnect: (...args) => client.$disconnect(...args),
  };
}

export function createReadOnlyPrismaClient(databaseUrl) {
  const client = new generated.PrismaClient({
    adapter: new PrismaPg({ connectionString: readOnlyDatabaseUrl(databaseUrl), max: 10 }),
  });
  return createReadOnlyDbInterface(client);
}

function normalizeStoredIsbn(isbn) {
  if (!isbn) return null;
  try {
    return normalizeIsbn13(isbn);
  } catch {
    try {
      return normalizeIsbn10ToIsbn13(isbn);
    } catch {
      return null;
    }
  }
}

export function normalizeCandidateIsbns(candidate) {
  const rawValues = [];
  if (Array.isArray(candidate.isbns)) rawValues.push(...candidate.isbns);
  if (typeof candidate.isbn === 'string') rawValues.push(candidate.isbn);
  const normalized = new Set();
  for (const value of rawValues) {
    const stored = normalizeStoredIsbn(value);
    if (stored) normalized.add(stored);
  }
  return normalized;
}

export function candidateTitleAuthorKey(candidate) {
  if (typeof candidate.primaryAuthor !== 'string' || !candidate.primaryAuthor.trim()) return null;
  if (typeof candidate.title !== 'string' || !candidate.title.trim()) return null;
  const identity = workIdentity({ title: candidate.title, author: candidate.primaryAuthor });
  const [titleKey, authorKey] = identity.split('\u0000');
  if (!titleKey || !authorKey) return null;
  return identity;
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
    const normalizedIsbn = normalizeStoredIsbn(book.isbn);
    if (normalizedIsbn) {
      const list = byIsbn.get(normalizedIsbn) ?? [];
      list.push(book.id);
      byIsbn.set(normalizedIsbn, list);
    }
    const identity = workIdentity(book);
    const [titleKey, authorKey] = identity.split('\u0000');
    if (!titleKey || !authorKey) continue;
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
  const { isbns: _isbns, isbn: _isbn, primaryAuthor: _primaryAuthor, languages: _languages, ...core } = candidate;
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
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new CatalogContractError('invalid_discover_artifact', 'Discover input must be an object');
  }
  if (!Array.isArray(artifact.candidates)) {
    throw new CatalogContractError('invalid_discover_artifact', 'Discover artifact candidates must be an array');
  }
  const view = enrichedArtifactForValidation(artifact);
  validateDiscoverArtifact({
    ...view,
    candidates: view.candidates.map(stripCandidateEnrichment),
  });
  return artifact.candidates;
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

export function validateDedupReport(results, expected) {
  if (results.length !== expected.length) {
    throw new CatalogContractError('invalid_dedup_report', 'Dedup report line count does not match the result set');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const written = results[index];
    const source = expected[index];
    for (const field of ['workKey', 'title', 'status', 'matchedBy']) {
      if (written[field] !== source[field]) {
        throw new CatalogContractError('invalid_dedup_report', `Dedup report line ${index + 1} does not match the expected ${field}`);
      }
    }
    if (JSON.stringify(written.matchedBookIds) !== JSON.stringify(source.matchedBookIds)) {
      throw new CatalogContractError('invalid_dedup_report', `Dedup report line ${index + 1} does not match the expected matchedBookIds`);
    }
  }
}

export async function writeDedupReport(outputPath, results) {
  const resolved = resolve(outputPath);
  const lines = results.map(result => `${JSON.stringify(result)}\n`).join('');
  await writeFileAtomic(resolved, lines, {
    mode: 0o600,
    validate: async content => {
      const parsed = content
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => JSON.parse(line));
      validateDedupReport(parsed, results);
    },
  });
}

export async function runCatalogDedupCheck({ db, inputPath, outputPath }) {
  const candidates = await loadDiscoverCandidates(inputPath);
  const { results, summary } = await checkCatalogDuplicates(db, candidates);
  await writeDedupReport(outputPath, results);
  return { results, summary, outputPath: resolve(outputPath) };
}
