import '../tests/setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prisma } from '../src/lib/prisma.js';
import { CATALOG_DISCOVER_FORMAT, CATALOG_DISCOVER_VERSION, popularityScore } from '../scripts/catalog/discover.js';
import {
  candidateTitleAuthorKey,
  checkCatalogDuplicates,
  createReadOnlyDbGuard,
  isValidOpenLibraryWorkKey,
  loadDiscoverCandidates,
  normalizeCandidateIsbns,
  readDedupReport,
  runCatalogDedupCheck,
} from '../src/services/catalogDedupCheckService.js';

const execFileAsync = promisify(execFile);

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
      update: async () => recordWrite('update'),
      updateMany: async () => recordWrite('updateMany'),
      upsert: async () => recordWrite('upsert'),
      delete: async () => recordWrite('delete'),
      deleteMany: async () => recordWrite('deleteMany'),
    },
    $transaction: async callback => callback(db),
    $executeRaw: async () => recordWrite('$executeRaw'),
    $executeRawUnsafe: async () => recordWrite('$executeRawUnsafe'),
    $queryRawUnsafe: async () => recordWrite('$queryRawUnsafe'),
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

test('candidateTitleAuthorKey normalizes title and primary author', () => {
  assert.equal(
    candidateTitleAuthorKey({ title: 'The Café Society!', primaryAuthor: 'Émile Zola' }),
    'cafe society\u0000emile zola',
  );
  assert.equal(candidateTitleAuthorKey({ title: 'A Study in Scarlet', primaryAuthor: 'Doyle, Arthur' }), 'study in scarlet\u0000arthur doyle');
  assert.equal(candidateTitleAuthorKey({ title: 'No Author' }), null);
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

test('checkCatalogDuplicates reports new when no match is found', async () => {
  const db = createMockDb([]);
  const { results, summary } = await checkCatalogDuplicates(db, [discoverCandidate()]);
  assert.equal(results[0].status, 'new');
  assert.deepEqual(results[0].matchedBookIds, []);
  assert.equal(results[0].matchedBy, null);
  assert.deepEqual(summary, { new: 1, existing: 0, ambiguous: 0 });
});

test('createReadOnlyDbGuard rejects write methods', async () => {
  const db = createMockDb([]);
  const guarded = createReadOnlyDbGuard(db);
  assert.throws(() => guarded.book.create({ data: {} }), /read-only/);
  assert.throws(() => guarded.book.update({ where: { id: 'x' }, data: {} }), /read-only/);
  assert.throws(() => guarded.book.delete({ where: { id: 'x' } }), /read-only/);
  assert.throws(() => guarded.$executeRaw('SELECT 1'), /read-only/);
  await assert.rejects(guarded.$transaction(async tx => tx.book.create({ data: {} })), /read-only/);
  assert.equal(db._writes.length, 0);
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

test('loadDiscoverCandidates validates discover artifacts', async () => {
  const directory = await temporaryDirectory();
  const inputPath = join(directory, 'discover.json');
  await fs.writeFile(inputPath, `${JSON.stringify(discoverArtifact([discoverCandidate()]))}\n`, 'utf8');
  const candidates = await loadDiscoverCandidates(inputPath);
  assert.equal(candidates.length, 1);
  await assert.rejects(loadDiscoverCandidates(join(directory, 'missing.json')), /Unable to read discover input/);
});

test('PostgreSQL: catalog dedup check performs only findMany reads', { timeout: 60000 }, async t => {
  const tag = randomUUID().slice(0, 8);
  const seed = Number.parseInt(tag, 16) % 1000000;
  const isbn = isbnAt(seed);
  const book = await prisma.book.create({
    data: {
      title: 'Dedup Integration',
      author: 'Integration Author',
      isbn,
      openLibraryWorkKey: `/works/OL${seed}W`,
    },
  });
  t.after(async () => {
    await prisma.book.deleteMany({ where: { id: book.id } });
    await prisma.$disconnect();
  });

  const directory = await temporaryDirectory();
  const inputPath = join(directory, 'discover.json');
  const outputPath = join(directory, 'report.jsonl');
  await fs.writeFile(inputPath, `${JSON.stringify(discoverArtifact([
    discoverCandidate({ workKey: book.openLibraryWorkKey, isbns: [isbn], title: book.title, primaryAuthor: book.author }),
    discoverCandidate({ workKey: '/works/OL999999W', title: 'Unmatched Title' }),
  ]))}\n`, 'utf8');

  const guarded = createReadOnlyDbGuard(prisma);
  const { summary, results } = await runCatalogDedupCheck({ db: guarded, inputPath, outputPath });
  assert.deepEqual(summary, { new: 1, existing: 1, ambiguous: 0 });
  assert.equal(results[0].matchedBookIds[0], book.id);
});

test('catalog:dedup-check CLI writes report and prints summary', async () => {
  const directory = await temporaryDirectory();
  const inputPath = join(directory, 'discover.json');
  const outputPath = join(directory, 'report.jsonl');
  await fs.writeFile(inputPath, `${JSON.stringify(discoverArtifact([
    discoverCandidate({ workKey: '/works/OL700W', title: 'CLI Candidate' }),
  ]))}\n`, 'utf8');

  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/catalog-dedup-check.js',
    '--input', inputPath,
    '--output', outputPath,
  ], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://bookish:bookish@127.0.0.1:5432/bookish_test',
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
      CLIENT_ORIGIN: process.env.CLIENT_ORIGIN,
    },
  });
  assert.deepEqual(JSON.parse(stdout.trim()), { new: 1, existing: 0, ambiguous: 0 });
  const lines = await readDedupReport(outputPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].status, 'new');
});
