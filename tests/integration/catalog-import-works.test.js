import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../src/lib/prisma.js';
import {
  CATALOG_DISCOVER_FORMAT,
  CATALOG_DISCOVER_SCORING,
  CATALOG_DISCOVER_VERSION,
  popularityScore,
} from '../../scripts/catalog/discover.js';
import {
  catalogImportSummaryPath,
  createImportPrismaClient,
  importCatalogWorks,
} from '../../scripts/catalog/import.js';
import { sealLanguageCheckedArtifact } from '../catalog/language-check-helpers.js';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../scripts/import-catalog.js', import.meta.url));

function isbnAt(index) {
  const stem = `979${String(index).padStart(9, '0')}`;
  const sum = [...stem].reduce((total, digit, position) => total + Number(digit) * (position % 2 ? 3 : 1), 0);
  return `${stem}${(10 - sum % 10) % 10}`;
}

function enrichedCandidate(overrides = {}) {
  const signals = {
    ratingsCount: 5,
    ratingsSum: 20,
    readingLog: { 'Want to Read': 1, 'Currently Reading': 1, 'Already Read': 10 },
    ...(overrides.signals ?? {}),
  };
  const { signals: _signals, score: scoreOverride, isbns, primaryAuthor, ...rest } = overrides;
  return {
    workKey: '/works/OL1000001W',
    title: 'Fixture Title',
    authorKeys: ['/authors/OL1A'],
    coverIds: [42],
    score: scoreOverride ?? popularityScore(signals),
    signals,
    isbns: [...(isbns ?? [])].sort(),
    primaryAuthor: primaryAuthor === undefined ? 'Fixture Author' : primaryAuthor,
    ...rest,
  };
}

function byRank(left, right) {
  return right.score - left.score || (left.workKey < right.workKey ? -1 : left.workKey > right.workKey ? 1 : 0);
}

function enrichedArtifact(candidates, languageCheck = 'pending') {
  const sorted = [...candidates].sort(byRank);
  const artifact = {
    format: CATALOG_DISCOVER_FORMAT,
    version: CATALOG_DISCOVER_VERSION,
    snapshotId: 'fixture-snapshot',
    generatedAt: '2026-08-31T00:00:00.000Z',
    languageCheck,
    scoring: { ...CATALOG_DISCOVER_SCORING },
    counts: {
      considered: sorted.length,
      filteredByReason: {
        invalid_work_key: 0,
        missing_title: 0,
        missing_cover: 0,
        excluded: 0,
        no_signal: 0,
        below_min_ratings: 0,
        below_min_readers: 0,
      },
      eligible: sorted.length,
      selected: sorted.length,
    },
    candidates: sorted,
  };
  if (languageCheck !== 'passed') return artifact;
  return sealLanguageCheckedArtifact(artifact);
}

function reportRow(candidate, status = 'new') {
  return {
    workKey: candidate.workKey,
    title: candidate.title,
    status,
    matchedBookIds: status === 'new' ? [] : ['00000000-0000-4000-8000-000000000001'],
    matchedBy: status === 'new' ? null : status === 'ambiguous' ? 'isbn' : 'openLibraryWorkKey',
  };
}

async function temporaryDirectory() {
  return fs.mkdtemp(join(tmpdir(), 'bookish-import-works-integration-'));
}

test('PostgreSQL: --apply inserts mapped works and a rerun inserts 0', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const seed = 800_000_000 + (Number.parseInt(randomUUID().slice(0, 6), 16) % 1_000_000);
  const lower = isbnAt(seed);
  const higher = isbnAt(seed + 1);
  const withIsbn = enrichedCandidate({
    workKey: `/works/OL${seed}W`,
    title: 'Imported With ISBN',
    primaryAuthor: 'Octavia Butler',
    isbns: [higher, lower],
    coverIds: [42],
  });
  const withoutIsbn = enrichedCandidate({
    workKey: `/works/OL${seed + 1}W`,
    title: 'Imported Without ISBN',
    primaryAuthor: 'Ursula K. Le Guin',
    isbns: [],
    coverIds: [7],
  });
  const existing = enrichedCandidate({
    workKey: `/works/OL${seed + 2}W`,
    title: 'Reported Existing',
    primaryAuthor: 'Existing Author',
  });
  const ambiguous = enrichedCandidate({
    workKey: `/works/OL${seed + 3}W`,
    title: 'Reported Ambiguous',
    primaryAuthor: 'Ambiguous Author',
  });
  const missingAuthor = enrichedCandidate({
    workKey: `/works/OL${seed + 4}W`,
    title: 'Missing Author',
    primaryAuthor: null,
  });
  const candidates = [withIsbn, withoutIsbn, existing, ambiguous, missingAuthor];
  const workKeys = candidates.map(candidate => candidate.workKey);
  t.after(async () => {
    await prisma.book.deleteMany({ where: { openLibraryWorkKey: { in: workKeys } } });
    await prisma.$disconnect();
  });

  const artifact = enrichedArtifact(candidates, 'passed');
  const reportRows = [
    reportRow(withIsbn),
    reportRow(withoutIsbn),
    reportRow(existing, 'existing'),
    reportRow(ambiguous, 'ambiguous'),
    reportRow(missingAuthor),
  ];
  const first = await importCatalogWorks({
    db: prisma,
    reportRows,
    artifact,
    apply: true,
    limit: 10,
    batchSize: 2,
  });
  assert.equal(first.summary.inserted, 2);
  assert.equal(first.summary.failed, 0);
  assert.equal(first.summary.skipped.existing, 1);
  assert.equal(first.summary.skipped.ambiguous, 1);
  assert.equal(first.summary.skipped.missing_author, 1);
  assert.equal(first.exitCode, 0);

  const stored = await prisma.book.findUnique({
    where: { openLibraryWorkKey: withIsbn.workKey },
    select: {
      title: true,
      author: true,
      isbn: true,
      openLibraryWorkKey: true,
      coverImageUrl: true,
      publicationYear: true,
      ratingsCount: true,
      averageRating: true,
    },
  });
  assert.deepEqual(stored, {
    title: 'Imported With ISBN',
    author: 'Octavia Butler',
    isbn: [lower, higher].sort()[0],
    openLibraryWorkKey: withIsbn.workKey,
    coverImageUrl: 'https://covers.openlibrary.org/b/id/42-L.jpg?default=false',
    publicationYear: null,
    ratingsCount: 0,
    averageRating: null,
  });
  const noIsbn = await prisma.book.findUnique({
    where: { openLibraryWorkKey: withoutIsbn.workKey },
    select: { isbn: true, author: true, coverImageUrl: true },
  });
  assert.deepEqual(noIsbn, {
    isbn: null,
    author: 'Ursula K. Le Guin',
    coverImageUrl: 'https://covers.openlibrary.org/b/id/7-L.jpg?default=false',
  });
  assert.equal(await prisma.book.count({ where: { openLibraryWorkKey: { in: [existing.workKey, ambiguous.workKey, missingAuthor.workKey] } } }), 0);

  const second = await importCatalogWorks({
    db: prisma,
    reportRows,
    artifact,
    apply: true,
    limit: 10,
    batchSize: 2,
  });
  assert.equal(second.summary.inserted, 0);
  assert.equal(second.summary.skipped.duplicate_work_key, 2);
  assert.equal(await prisma.book.count({ where: { openLibraryWorkKey: { in: workKeys } } }), 2);
});

test('PostgreSQL: a pre-existing work key or ISBN is skipped without changing that row', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const seed = 810_000_000 + (Number.parseInt(randomUUID().slice(0, 6), 16) % 1_000_000);
  const existingIsbn = isbnAt(seed);
  const existingKey = `/works/OL${seed}W`;
  const isbnBook = await prisma.book.create({
    data: { title: 'Keep ISBN Title', author: 'Keep ISBN Author', isbn: existingIsbn },
  });
  const keyBook = await prisma.book.create({
    data: { title: 'Keep Key Title', author: 'Keep Key Author', openLibraryWorkKey: existingKey },
  });
  const freshKey = `/works/OL${seed + 1}W`;
  const freshIsbnKey = `/works/OL${seed + 2}W`;
  t.after(async () => {
    await prisma.book.deleteMany({ where: { id: { in: [isbnBook.id, keyBook.id] } } });
    await prisma.book.deleteMany({ where: { openLibraryWorkKey: { in: [freshKey, freshIsbnKey, existingKey] } } });
    await prisma.$disconnect();
  });
  const beforeIsbn = await prisma.book.findUnique({ where: { id: isbnBook.id } });
  const beforeKey = await prisma.book.findUnique({ where: { id: keyBook.id } });
  const isbnCandidate = enrichedCandidate({
    workKey: freshIsbnKey,
    title: 'Should Not Insert ISBN',
    primaryAuthor: 'New Author',
    isbns: [existingIsbn],
  });
  const keyCandidate = enrichedCandidate({
    workKey: existingKey,
    title: 'Should Not Insert Key',
    primaryAuthor: 'New Author',
    isbns: [isbnAt(seed + 3)],
  });
  const { summary } = await importCatalogWorks({
    db: prisma,
    reportRows: [reportRow(isbnCandidate), reportRow(keyCandidate)],
    artifact: enrichedArtifact([isbnCandidate, keyCandidate], 'passed'),
    apply: true,
    limit: 10,
    batchSize: 10,
  });
  assert.equal(summary.inserted, 0);
  assert.equal(summary.skipped.duplicate_isbn, 1);
  assert.equal(summary.skipped.duplicate_work_key, 1);
  assert.equal(await prisma.book.count({ where: { openLibraryWorkKey: freshIsbnKey } }), 0);
  const afterIsbn = await prisma.book.findUnique({ where: { id: isbnBook.id } });
  const afterKey = await prisma.book.findUnique({ where: { id: keyBook.id } });
  assert.equal(afterIsbn.title, 'Keep ISBN Title');
  assert.equal(afterIsbn.isbn, existingIsbn);
  assert.equal(afterIsbn.openLibraryWorkKey, null);
  assert.equal(afterIsbn.updatedAt.getTime(), beforeIsbn.updatedAt.getTime());
  assert.equal(afterKey.title, 'Keep Key Title');
  assert.equal(afterKey.isbn, null);
  assert.equal(afterKey.updatedAt.getTime(), beforeKey.updatedAt.getTime());
});

test('PostgreSQL: dry-run leaves the database unchanged', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const seed = 820_000_000 + (Number.parseInt(randomUUID().slice(0, 6), 16) % 1_000_000);
  const existing = await prisma.book.create({
    data: {
      title: 'Dry Run Existing',
      author: 'Dry Run Author',
      isbn: isbnAt(seed),
      openLibraryWorkKey: `/works/OL${seed}W`,
    },
  });
  const candidate = enrichedCandidate({
    workKey: `/works/OL${seed + 1}W`,
    title: 'Dry Run New',
    primaryAuthor: 'New Author',
    isbns: [isbnAt(seed + 1)],
  });
  t.after(async () => {
    await prisma.book.deleteMany({ where: { id: existing.id } });
    await prisma.book.deleteMany({ where: { openLibraryWorkKey: candidate.workKey } });
    await prisma.$disconnect();
  });
  const before = await prisma.book.findUnique({ where: { id: existing.id } });
  const db = createImportPrismaClient(process.env.TEST_DATABASE_URL, { apply: false });
  assert.equal(db.book.createMany, undefined);
  assert.equal(db.$transaction, undefined);
  const directory = await temporaryDirectory();
  const outputPath = join(directory, 'dry-run.jsonl');
  try {
    const { summary } = await importCatalogWorks({
      db,
      reportRows: [reportRow(candidate)],
      artifact: enrichedArtifact([candidate]),
      apply: false,
      limit: 10,
      batchSize: 10,
      outputPath,
    });
    assert.equal(summary.mode, 'dry-run');
    assert.equal(summary.inserted, 0);
    assert.equal(summary.planned, 1);
    assert.equal(summary.failed, 0);
  } finally {
    await db.$disconnect();
  }
  const after = await prisma.book.findUnique({ where: { id: existing.id } });
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
  assert.equal(after.title, before.title);
  assert.equal(await prisma.book.count({ where: { openLibraryWorkKey: candidate.workKey } }), 0);
  const written = JSON.parse(await fs.readFile(catalogImportSummaryPath(outputPath), 'utf8'));
  assert.equal(written.inserted, 0);
  assert.equal(written.planned, 1);
});

test('PostgreSQL: a failing batch rolls back only that batch', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const seed = 830_000_000 + (Number.parseInt(randomUUID().slice(0, 6), 16) % 1_000_000);
  const candidates = [0, 1, 2].map(offset => enrichedCandidate({
    workKey: `/works/OL${seed + offset}W`,
    title: `Batch ${offset}`,
    primaryAuthor: 'Batch Author',
    isbns: [isbnAt(seed + offset)],
  }));
  const workKeys = candidates.map(candidate => candidate.workKey);
  t.after(async () => {
    await prisma.book.deleteMany({ where: { openLibraryWorkKey: { in: workKeys } } });
    await prisma.$disconnect();
  });
  const { summary, rows, exitCode } = await importCatalogWorks({
    db: prisma,
    reportRows: candidates.map(candidate => reportRow(candidate)),
    artifact: enrichedArtifact(candidates, 'passed'),
    apply: true,
    limit: 3,
    batchSize: 1,
    afterBatchInsert: async ({ index, tx }) => {
      if (index !== 1) return;
      const visible = await tx.book.findMany({ where: { openLibraryWorkKey: workKeys[1] }, select: { id: true } });
      assert.equal(visible.length, 1);
      throw new Error('injected batch failure');
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(summary.inserted, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.errors[0].workKey, workKeys[1]);
  assert.match(summary.errors[0].error, /injected batch failure/);
  assert.deepEqual(rows.map(row => row.action), ['insert', 'fail', 'insert']);
  assert.equal(await prisma.book.count({ where: { openLibraryWorkKey: workKeys[0] } }), 1);
  assert.equal(await prisma.book.count({ where: { openLibraryWorkKey: workKeys[1] } }), 0);
  assert.equal(await prisma.book.count({ where: { openLibraryWorkKey: workKeys[2] } }), 1);
});

test('PostgreSQL: catalog:import CLI --apply inserts and the default dry-run does not', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const seed = 840_000_000 + (Number.parseInt(randomUUID().slice(0, 6), 16) % 1_000_000);
  const applied = enrichedCandidate({
    workKey: `/works/OL${seed}W`,
    title: 'CLI Applied',
    primaryAuthor: 'CLI Author',
    isbns: [isbnAt(seed)],
  });
  const planned = enrichedCandidate({
    workKey: `/works/OL${seed + 1}W`,
    title: 'CLI Planned',
    primaryAuthor: 'CLI Author',
    isbns: [isbnAt(seed + 1)],
  });
  const workKeys = [applied.workKey, planned.workKey];
  t.after(async () => {
    await prisma.book.deleteMany({ where: { openLibraryWorkKey: { in: workKeys } } });
    await prisma.$disconnect();
  });
  const directory = await temporaryDirectory();
  const applyReport = join(directory, 'apply-report.jsonl');
  const applyEnriched = join(directory, 'apply-enriched.json');
  const applyOutput = join(directory, 'apply-out.jsonl');
  const planReport = join(directory, 'plan-report.jsonl');
  const planEnriched = join(directory, 'plan-enriched.json');
  const planOutput = join(directory, 'plan-out.jsonl');
  await fs.writeFile(applyEnriched, `${JSON.stringify(enrichedArtifact([applied], 'passed'))}\n`);
  await fs.writeFile(applyReport, `${JSON.stringify(reportRow(applied))}\n`);
  await fs.writeFile(planEnriched, `${JSON.stringify(enrichedArtifact([planned]))}\n`);
  await fs.writeFile(planReport, `${JSON.stringify(reportRow(planned))}\n`);
  const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL };
  const apply = await execFileAsync(process.execPath, [
    SCRIPT,
    '--report', applyReport,
    '--enriched', applyEnriched,
    '--output', applyOutput,
    '--apply',
    '--limit', '50',
    '--batch-size', '10',
  ], { env });
  const applySummary = JSON.parse(apply.stdout);
  assert.equal(applySummary.inserted, 1);
  assert.equal(applySummary.limit, 50);
  const stored = await prisma.book.findUnique({
    where: { openLibraryWorkKey: applied.workKey },
    select: { title: true, author: true, isbn: true },
  });
  assert.deepEqual(stored, { title: 'CLI Applied', author: 'CLI Author', isbn: isbnAt(seed) });
  const again = await execFileAsync(process.execPath, [
    SCRIPT,
    '--report', applyReport,
    '--enriched', applyEnriched,
    '--output', applyOutput,
    '--apply',
    '--limit', '50',
  ], { env });
  assert.equal(JSON.parse(again.stdout).inserted, 0);
  const dry = await execFileAsync(process.execPath, [
    SCRIPT,
    '--report', planReport,
    '--enriched', planEnriched,
    '--output', planOutput,
    '--limit', '50',
  ], { env });
  const drySummary = JSON.parse(dry.stdout);
  assert.equal(drySummary.mode, 'dry-run');
  assert.equal(drySummary.inserted, 0);
  assert.equal(drySummary.planned, 1);
  assert.equal(await prisma.book.count({ where: { openLibraryWorkKey: planned.workKey } }), 0);
});
