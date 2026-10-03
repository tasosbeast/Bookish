import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG_DISCOVER_FORMAT, CATALOG_DISCOVER_VERSION, popularityScore } from '../scripts/catalog/discover.js';
import { workIdentity } from '../scripts/catalog/work-identity.js';
import {
  candidateTitleAuthorKey,
  checkCatalogDuplicates,
  createReadOnlyDbInterface,
  isValidOpenLibraryWorkKey,
  loadDiscoverCandidates,
  normalizeCandidateIsbns,
  readDedupReport,
  runCatalogDedupCheck,
} from '../scripts/catalog/dedup-check.js';

function isbnAt(index) {
  const stem = `979${String(index).padStart(9, '0')}`;
  const sum = [...stem].reduce((total, digit, position) => total + Number(digit) * (position % 2 ? 3 : 1), 0);
  return `${stem}${(10 - sum % 10) % 10}`;
}

function discoverArtifact(candidates) {
  return {
    format: CATALOG_DISCOVER_FORMAT,
    version: CATALOG_DISCOVER_VERSION,
    snapshotId: 'fixture-snapshot',
    generatedAt: '2026-08-31T00:00:00.000Z',
    languageCheck: 'pending',
    scoring: {
      priorRatings: 20,
      priorMean: 3.5,
      alreadyReadWeight: 1,
      currentlyReadingWeight: 0.75,
      wantToReadWeight: 0.25,
      minRatings: 0,
      minReaders: 10,
    },
    counts: {
      considered: candidates.length,
      filteredByReason: {
        invalid_work_key: 0,
        missing_title: 0,
        missing_cover: 0,
        excluded: 0,
        no_signal: 0,
        below_min_ratings: 0,
        below_min_readers: 0,
      },
      eligible: candidates.length,
      selected: candidates.length,
    },
    candidates,
  };
}

function discoverCandidate(overrides = {}) {
  const signals = {
    ratingsCount: 5,
    ratingsSum: 20,
    readingLog: { 'Want to Read': 1, 'Currently Reading': 1, 'Already Read': 10 },
    ...(overrides.signals ?? {}),
  };
  const { signals: _signals, score: scoreOverride, ...rest } = overrides;
  return {
    workKey: '/works/OL100W',
    title: 'Fixture Title',
    authorKeys: ['/authors/OL1A'],
    coverIds: [1],
    score: scoreOverride ?? popularityScore(signals),
    signals,
    ...rest,
  };
}

function createMockDb(initialBooks = []) {
  const books = new Map(initialBooks.map(book => [book.id, structuredClone(book)]));
  const writes = [];

  const select = (row, fields) => {
    if (!fields) return structuredClone(row);
    return Object.fromEntries(Object.keys(fields).filter(key => fields[key]).map(key => [key, row[key]]));
  };

  const recordWrite = method => {
    writes.push(method);
    throw new Error(`write method ${method} must not be called`);
  };

  const db = {
    book: {
      findMany: async ({ select: fields } = {}) => [...books.values()].map(book => select(book, fields)),
      create: async () => recordWrite('create'),
      createMany: async () => recordWrite('createMany'),
      createManyAndReturn: async () => recordWrite('createManyAndReturn'),
      update: async () => recordWrite('update'),
      updateMany: async () => recordWrite('updateMany'),
      updateManyAndReturn: async () => recordWrite('updateManyAndReturn'),
      upsert: async () => recordWrite('upsert'),
      delete: async () => recordWrite('delete'),
      deleteMany: async () => recordWrite('deleteMany'),
    },
    $transaction: async callback => callback(db),
    $executeRaw: async () => recordWrite('$executeRaw'),
    $executeRawUnsafe: async () => recordWrite('$executeRawUnsafe'),
    $queryRaw: async () => recordWrite('$queryRaw'),
    $queryRawUnsafe: async () => recordWrite('$queryRawUnsafe'),
    $extends: () => recordWrite('$extends'),
    _writes: writes,
    _books: books,
  };

  return db;
}

async function temporaryDirectory() {
  return fs.mkdtemp(join(tmpdir(), 'bookish-dedup-check-'));
}

test('isValidOpenLibraryWorkKey accepts valid keys and rejects empty or malformed values', () => {
  assert.equal(isValidOpenLibraryWorkKey('/works/OL123W'), true);
  assert.equal(isValidOpenLibraryWorkKey(''), false);
  assert.equal(isValidOpenLibraryWorkKey('/works/OL123'), false);
  assert.equal(isValidOpenLibraryWorkKey('/works/OL123M'), false);
});

test('normalizeCandidateIsbns normalizes ISBN-13 and converts ISBN-10 to ISBN-13', () => {
  const isbns = normalizeCandidateIsbns({
    isbns: ['978-0-14-143951-8', '0141439513', 'not-an-isbn'],
  });
  assert.deepEqual([...isbns], ['9780141439518']);
});

test('candidateTitleAuthorKey uses workIdentity and skips empty normalized title or author', () => {
  assert.equal(
    candidateTitleAuthorKey({ title: 'The Café Society!', primaryAuthor: 'Émile Zola' }),
    workIdentity({ title: 'The Café Society!', author: 'Émile Zola' }),
  );
  assert.equal(
    candidateTitleAuthorKey({ title: 'A Study in Scarlet', primaryAuthor: 'Doyle, Arthur' }),
    workIdentity({ title: 'A Study in Scarlet', author: 'Doyle, Arthur' }),
  );
  assert.equal(candidateTitleAuthorKey({ title: 'No Author' }), null);
  assert.equal(candidateTitleAuthorKey({ title: 'Βίβλος', primaryAuthor: 'Συγγραφέας' }), null);
});

test('checkCatalogDuplicates matches by openLibraryWorkKey', async () => {
  const db = createMockDb([
    { id: 'book-1', title: 'Stored', author: 'Author', isbn: null, openLibraryWorkKey: '/works/OL100W' },
  ]);
  const { results, summary } = await checkCatalogDuplicates(db, [discoverCandidate({ workKey: '/works/OL100W' })]);
  assert.deepEqual(results, [{
    workKey: '/works/OL100W',
    title: 'Fixture Title',
    status: 'existing',
    matchedBookIds: ['book-1'],
    matchedBy: 'openLibraryWorkKey',
  }]);
  assert.deepEqual(summary, { new: 0, existing: 1, ambiguous: 0 });
});

test('checkCatalogDuplicates matches by normalized ISBN-13', async () => {
  const isbn = isbnAt(42);
  const db = createMockDb([
    { id: 'book-2', title: 'ISBN Match', author: 'Author', isbn, openLibraryWorkKey: null },
  ]);
  const { results } = await checkCatalogDuplicates(db, [
    discoverCandidate({ workKey: '/works/OL999W', isbns: [isbn] }),
  ]);
  assert.equal(results[0].status, 'existing');
  assert.equal(results[0].matchedBy, 'isbn');
  assert.deepEqual(results[0].matchedBookIds, ['book-2']);
});

test('checkCatalogDuplicates normalizes stored ISBN-10 values to ISBN-13', async () => {
  const db = createMockDb([
    { id: 'book-10', title: 'Pride and Prejudice', author: 'Austen, Jane', isbn: '0141439513', openLibraryWorkKey: null },
  ]);
  const { results } = await checkCatalogDuplicates(db, [
    discoverCandidate({ workKey: '/works/OL777W', isbns: ['9780141439518'] }),
  ]);
  assert.equal(results[0].status, 'existing');
  assert.equal(results[0].matchedBy, 'isbn');
});

test('checkCatalogDuplicates matches by normalized title and primary author', async () => {
  const db = createMockDb([
    { id: 'book-3', title: 'The Hobbit', author: 'Tolkien, J.R.R.', isbn: null, openLibraryWorkKey: null },
  ]);
  const { results } = await checkCatalogDuplicates(db, [
    discoverCandidate({
      workKey: '/works/OL888W',
      title: 'The Hobbit',
      primaryAuthor: 'J.R.R. Tolkien',
    }),
  ]);
  assert.equal(results[0].status, 'existing');
  assert.equal(results[0].matchedBy, 'titleAuthor');
  assert.deepEqual(results[0].matchedBookIds, ['book-3']);
});

test('checkCatalogDuplicates matches Dune parenthetical titles through workIdentity', async () => {
  const db = createMockDb([
    { id: 'book-dune', title: 'Dune', author: 'Herbert, Frank', isbn: null, openLibraryWorkKey: null },
  ]);
  const { results } = await checkCatalogDuplicates(db, [
    discoverCandidate({
      workKey: '/works/OL600W',
      title: 'Dune (Dune Chronicles, #1)',
      primaryAuthor: 'Frank Herbert',
    }),
  ]);
  assert.equal(results[0].status, 'existing');
  assert.equal(results[0].matchedBy, 'titleAuthor');
  assert.deepEqual(results[0].matchedBookIds, ['book-dune']);
});

test('checkCatalogDuplicates reports ambiguous when multiple books share a work key', async () => {
  const db = createMockDb([
    { id: 'book-a', title: 'A', author: 'Author', isbn: null, openLibraryWorkKey: '/works/OL200W' },
    { id: 'book-b', title: 'B', author: 'Author', isbn: null, openLibraryWorkKey: '/works/OL200W' },
  ]);
  const { results, summary } = await checkCatalogDuplicates(db, [discoverCandidate({ workKey: '/works/OL200W' })]);
  assert.equal(results[0].status, 'ambiguous');
  assert.equal(results[0].matchedBy, 'openLibraryWorkKey');
  assert.deepEqual(results[0].matchedBookIds, ['book-a', 'book-b']);
  assert.deepEqual(summary, { new: 0, existing: 0, ambiguous: 1 });
});

test('checkCatalogDuplicates reports ambiguous when work key and title-author disagree', async () => {
  const isbn = isbnAt(77);
  const db = createMockDb([
    { id: 'book-work', title: 'Work Match', author: 'Author A', isbn: null, openLibraryWorkKey: '/works/OL300W' },
    { id: 'book-title', title: 'The Hobbit', author: 'Tolkien, J.R.R.', isbn, openLibraryWorkKey: null },
  ]);
  const { results } = await checkCatalogDuplicates(db, [
    discoverCandidate({
      workKey: '/works/OL300W',
      title: 'The Hobbit',
      primaryAuthor: 'J.R.R. Tolkien',
      isbns: [isbn],
    }),
  ]);
  assert.equal(results[0].status, 'ambiguous');
  assert.deepEqual(results[0].matchedBookIds, ['book-title', 'book-work']);
});

test('checkCatalogDuplicates ignores invalid work keys and still matches by ISBN', async () => {
  const isbn = isbnAt(88);
  const db = createMockDb([
    { id: 'book-isbn', title: 'ISBN Only', author: 'Author', isbn, openLibraryWorkKey: null },
  ]);
  const { results } = await checkCatalogDuplicates(db, [
    discoverCandidate({ workKey: '', isbns: [isbn] }),
  ]);
  assert.equal(results[0].status, 'existing');
  assert.equal(results[0].matchedBy, 'isbn');
});

test('checkCatalogDuplicates treats unrelated Greek-only candidates as new', async () => {
  const db = createMockDb([
    { id: 'book-greek', title: 'Βίβλος', author: 'Συγγραφέας', isbn: null, openLibraryWorkKey: null },
    { id: 'book-other', title: 'Another', author: 'Writer', isbn: null, openLibraryWorkKey: null },
  ]);
  const { results } = await checkCatalogDuplicates(db, [
    discoverCandidate({
      workKey: '/works/OL950W',
      title: 'Διαφορετικό',
      primaryAuthor: 'Άλλος',
    }),
  ]);
  assert.equal(results[0].status, 'new');
  assert.deepEqual(results[0].matchedBookIds, []);
});

test('checkCatalogDuplicates reports new when no match is found', async () => {
  const db = createMockDb([]);
  const { results, summary } = await checkCatalogDuplicates(db, [discoverCandidate()]);
  assert.equal(results[0].status, 'new');
  assert.deepEqual(results[0].matchedBookIds, []);
  assert.equal(results[0].matchedBy, null);
  assert.deepEqual(summary, { new: 1, existing: 0, ambiguous: 0 });
});

test('createReadOnlyDbInterface exposes only findMany and disconnect', () => {
  const db = createMockDb([]);
  const readOnly = createReadOnlyDbInterface(db);
  assert.equal(typeof readOnly.book.findMany, 'function');
  assert.equal(typeof readOnly.$disconnect, 'function');
  assert.equal(readOnly.book.create, undefined);
  assert.equal(readOnly.book.createManyAndReturn, undefined);
  assert.equal(readOnly.$queryRaw, undefined);
  assert.equal(readOnly.$extends, undefined);
});

test('runCatalogDedupCheck writes JSONL and prints summary counts', async () => {
  const directory = await temporaryDirectory();
  const inputPath = join(directory, 'discover.json');
  const outputPath = join(directory, 'report.jsonl');
  const isbn = isbnAt(99);
  const db = createMockDb([
    { id: 'book-existing', title: 'Existing', author: 'Author', isbn, openLibraryWorkKey: '/works/OL400W' },
  ]);
  await fs.writeFile(inputPath, `${JSON.stringify(discoverArtifact([
    discoverCandidate({ workKey: '/works/OL400W', isbns: [isbn] }),
    discoverCandidate({ workKey: '/works/OL500W', title: 'Brand New' }),
  ]))}\n`, 'utf8');

  const { summary } = await runCatalogDedupCheck({ db, inputPath, outputPath });
  assert.deepEqual(summary, { new: 1, existing: 1, ambiguous: 0 });
  const lines = await readDedupReport(outputPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].status, 'existing');
  assert.equal(lines[1].status, 'new');
});

test('loadDiscoverCandidates validates discover artifacts and rejects missing candidates', async () => {
  const directory = await temporaryDirectory();
  const inputPath = join(directory, 'discover.json');
  await fs.writeFile(inputPath, `${JSON.stringify(discoverArtifact([discoverCandidate()]))}\n`, 'utf8');
  const candidates = await loadDiscoverCandidates(inputPath);
  assert.equal(candidates.length, 1);
  await assert.rejects(loadDiscoverCandidates(join(directory, 'missing.json')), /Unable to read discover input/);
  const invalidPath = join(directory, 'invalid.json');
  await fs.writeFile(invalidPath, '{"format":"bookish-catalog-discover"}', 'utf8');
  await assert.rejects(loadDiscoverCandidates(invalidPath), /Discover artifact candidates must be an array/);
});
