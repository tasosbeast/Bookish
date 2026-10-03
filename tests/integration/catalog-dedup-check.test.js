import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { prisma } from '../../src/lib/prisma.js';
import generated from '../../src/generated/prisma/index.js';
import { CATALOG_DISCOVER_FORMAT, CATALOG_DISCOVER_VERSION, popularityScore } from '../../scripts/catalog/discover.js';
import {
  createReadOnlyDbInterface,
  createReadOnlyPrismaClient,
  readOnlyDatabaseUrl,
  runCatalogDedupCheck,
} from '../../scripts/catalog/dedup-check.js';

const execFileAsync = promisify(execFile);

function createRawReadOnlyPrismaClient(databaseUrl) {
  return new generated.PrismaClient({
    adapter: new PrismaPg({ connectionString: readOnlyDatabaseUrl(databaseUrl), max: 10 }),
  });
}

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

async function temporaryDirectory() {
  return fs.mkdtemp(join(tmpdir(), 'bookish-dedup-check-integration-'));
}

async function snapshotBook(bookId) {
  return prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      title: true,
      author: true,
      isbn: true,
      openLibraryWorkKey: true,
    },
  });
}

test('PostgreSQL: catalog dedup check performs only findMany reads', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
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

  const readOnly = createReadOnlyPrismaClient(process.env.TEST_DATABASE_URL);
  const originalFindMany = readOnly.book.findMany;
  let findManyCalls = 0;
  readOnly.book.findMany = async (...args) => {
    findManyCalls += 1;
    return originalFindMany(...args);
  };

  const { summary, results } = await runCatalogDedupCheck({ db: readOnly, inputPath, outputPath });
  assert.deepEqual(summary, { new: 1, existing: 1, ambiguous: 0 });
  assert.equal(results[0].matchedBookIds[0], book.id);
  assert.equal(findManyCalls, 1);
  await readOnly.$disconnect();
});

test('PostgreSQL: read-only database URL rejects raw UPDATE statements', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const tag = randomUUID().slice(0, 8);
  const book = await prisma.book.create({
    data: {
      title: `Read-only execute ${tag}`,
      author: 'Author',
      openLibraryWorkKey: `/works/OL${tag}W`,
    },
  });
  const before = await snapshotBook(book.id);
  const readOnly = createRawReadOnlyPrismaClient(process.env.TEST_DATABASE_URL);
  t.after(async () => {
    await readOnly.$disconnect();
    await prisma.book.deleteMany({ where: { id: book.id } });
    await prisma.$disconnect();
  });

  await assert.rejects(
    () => readOnly.$executeRaw`UPDATE books SET title = 'changed' WHERE id=${book.id}`,
    /read-only|cannot execute/i,
  );
  const after = await snapshotBook(book.id);
  assert.equal(after.title, before.title);
  assert.notEqual(after.title, 'changed');
  assert.match(decodeURIComponent(readOnlyDatabaseUrl(process.env.TEST_DATABASE_URL)), /default_transaction_read_only=on/);
});

test('PostgreSQL: read-only database URL rejects $queryRaw UPDATE and leaves rows unchanged', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const tag = randomUUID().slice(0, 8);
  const book = await prisma.book.create({
    data: {
      title: `Read-only queryRaw ${tag}`,
      author: 'Author',
      openLibraryWorkKey: `/works/OL${tag}W`,
    },
  });
  const before = await snapshotBook(book.id);
  const readOnly = createRawReadOnlyPrismaClient(process.env.TEST_DATABASE_URL);
  t.after(async () => {
    await readOnly.$disconnect();
    await prisma.book.deleteMany({ where: { id: book.id } });
    await prisma.$disconnect();
  });

  await assert.rejects(
    () => readOnly.$queryRaw`UPDATE books SET title = 'changed' WHERE id=${book.id}`,
    /read-only|cannot execute/i,
  );
  const after = await snapshotBook(book.id);
  assert.equal(after.title, before.title);
  assert.notEqual(after.title, 'changed');
});

test('PostgreSQL: read-only database URL rejects updateManyAndReturn and leaves rows unchanged', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const tag = randomUUID().slice(0, 8);
  const book = await prisma.book.create({
    data: {
      title: `Read-only updateManyAndReturn ${tag}`,
      author: 'Author',
      openLibraryWorkKey: `/works/OL${tag}W`,
    },
  });
  const before = await snapshotBook(book.id);
  const readOnly = createRawReadOnlyPrismaClient(process.env.TEST_DATABASE_URL);
  t.after(async () => {
    await readOnly.$disconnect();
    await prisma.book.deleteMany({ where: { id: book.id } });
    await prisma.$disconnect();
  });

  await assert.rejects(
    () => readOnly.book.updateManyAndReturn({
      where: { id: book.id },
      data: { title: 'Changed Title' },
    }),
    /read-only|cannot execute/i,
  );
  assert.deepEqual(await snapshotBook(book.id), before);
});

test('PostgreSQL: read-only database URL rejects callback $transaction writes and leaves rows unchanged', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const tag = randomUUID().slice(0, 8);
  const book = await prisma.book.create({
    data: {
      title: `Read-only callback tx ${tag}`,
      author: 'Author',
      openLibraryWorkKey: `/works/OL${tag}W`,
    },
  });
  const before = await snapshotBook(book.id);
  const readOnly = createRawReadOnlyPrismaClient(process.env.TEST_DATABASE_URL);
  t.after(async () => {
    await readOnly.$disconnect();
    await prisma.book.deleteMany({ where: { id: book.id } });
    await prisma.$disconnect();
  });

  await assert.rejects(
    () => readOnly.$transaction(async tx => tx.book.update({
      where: { id: book.id },
      data: { title: 'Changed Title' },
    })),
    /read-only|cannot execute/i,
  );
  assert.deepEqual(await snapshotBook(book.id), before);
});

test('PostgreSQL: read-only database URL rejects array $transaction writes and leaves rows unchanged', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const tag = randomUUID().slice(0, 8);
  const book = await prisma.book.create({
    data: {
      title: `Read-only array tx ${tag}`,
      author: 'Author',
      openLibraryWorkKey: `/works/OL${tag}W`,
    },
  });
  const before = await snapshotBook(book.id);
  const readOnly = createRawReadOnlyPrismaClient(process.env.TEST_DATABASE_URL);
  t.after(async () => {
    await readOnly.$disconnect();
    await prisma.book.deleteMany({ where: { id: book.id } });
    await prisma.$disconnect();
  });

  await assert.rejects(
    () => readOnly.$transaction([
      readOnly.book.update({
        where: { id: book.id },
        data: { title: 'Changed Title' },
      }),
    ]),
    /read-only|cannot execute/i,
  );
  assert.deepEqual(await snapshotBook(book.id), before);
});

test('PostgreSQL: read-only interface blocks createManyAndReturn', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const readOnly = createReadOnlyDbInterface(prisma);
  t.after(async () => {
    await prisma.$disconnect();
  });
  assert.throws(
    () => readOnly.book.createManyAndReturn({ data: [{ title: 'Blocked', author: 'Author' }] }),
    TypeError,
  );
});

test('PostgreSQL: read-only interface blocks $extends bypass', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const readOnly = createReadOnlyDbInterface(prisma);
  t.after(async () => {
    await prisma.$disconnect();
  });
  assert.throws(() => readOnly.$extends({}), TypeError);
});

test('catalog:dedup-check CLI writes report and prints summary', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async () => {
  const directory = await temporaryDirectory();
  const inputPath = join(directory, 'discover.json');
  const outputPath = join(directory, 'report.jsonl');
  await fs.writeFile(inputPath, `${JSON.stringify(discoverArtifact([
    discoverCandidate({ workKey: '/works/OL700W', title: 'CLI Candidate' }),
  ]))}\n`, 'utf8');

  const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL };
  delete env.JWT_ACCESS_SECRET;
  delete env.JWT_REFRESH_SECRET;
  delete env.CLIENT_ORIGIN;
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/catalog-dedup-check.js',
    '--input', inputPath,
    '--output', outputPath,
  ], {
    cwd: join(import.meta.dirname, '../..'),
    env,
  });
  assert.deepEqual(JSON.parse(stdout.trim()), { new: 1, existing: 0, ambiguous: 0 });
});
