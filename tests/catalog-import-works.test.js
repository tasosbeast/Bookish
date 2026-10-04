import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CatalogContractError } from '../scripts/catalog/contracts.js';
import {
  CATALOG_DISCOVER_FORMAT,
  CATALOG_DISCOVER_SCORING,
  CATALOG_DISCOVER_VERSION,
  popularityScore,
} from '../scripts/catalog/discover.js';
import { normalizeIsbn10ToIsbn13 } from '../scripts/catalog/normalize.js';
import {
  CATALOG_IMPORT_AUTHOR_MAX_LENGTH,
  CATALOG_IMPORT_DEFAULT_BATCH_SIZE,
  CATALOG_IMPORT_DEFAULT_LIMIT,
  CATALOG_IMPORT_SKIP_REASONS,
  CATALOG_IMPORT_TITLE_MAX_LENGTH,
  catalogImportSummaryPath,
  candidateImportSkipReason,
  createImportPrismaClient,
  importCatalogWorks,
  lowestImportIsbn,
  mapCandidateToBook,
  parseCatalogWorksImportArgs,
  writeCatalogImportReport,
} from '../scripts/catalog/import.js';
import { sealLanguageCheckedArtifact } from '../scripts/catalog/language-check.js';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/import-catalog.js', import.meta.url));
const SNAPSHOT_ID = 'fixture-snapshot';

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
    coverIds: [1],
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

function enrichedArtifact(candidates, snapshotId = SNAPSHOT_ID, languageCheck = 'pending') {
  const sorted = [...candidates].sort(byRank);
  const artifact = {
    format: CATALOG_DISCOVER_FORMAT,
    version: CATALOG_DISCOVER_VERSION,
    snapshotId,
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

function reportRow(candidate, status = 'new', extra = {}) {
  return {
    workKey: candidate.workKey,
    title: candidate.title,
    status,
    matchedBookIds: status === 'new' ? [] : ['00000000-0000-4000-8000-000000000001'],
    matchedBy: status === 'new' ? null : 'openLibraryWorkKey',
    ...extra,
  };
}

function key(index) {
  return `/works/OL${String(2000000 + index)}W`;
}

async function temporaryDirectory() {
  return fs.mkdtemp(join(tmpdir(), 'bookish-import-works-'));
}

function skipCounts(overrides = {}) {
  return Object.fromEntries(CATALOG_IMPORT_SKIP_REASONS.map(reason => [reason, overrides[reason] ?? 0]));
}

test('mapCandidateToBook stores the lowest ISBN-13, primary author, cover, and a schema-valid year', () => {
  const higher = isbnAt(20);
  const lower = isbnAt(10);
  const from10 = normalizeIsbn10ToIsbn13('0306406152');
  assert.equal(lowestImportIsbn({ isbns: ['9780000000000', higher, '0306406152', lower] }), [from10, lower, higher].sort()[0]);
  assert.equal(lowestImportIsbn({ isbns: ['not-an-isbn'] }), null);
  const mapped = mapCandidateToBook({
    workKey: '/works/OL42W',
    title: '  Kindred  ',
    primaryAuthor: '  Octavia Butler  ',
    isbns: [higher, lower],
    coverIds: [42, 7],
    publicationYear: 1979,
  });
  assert.equal(mapped.skip, undefined);
  assert.deepEqual(mapped.book, {
    title: 'Kindred',
    author: 'Octavia Butler',
    isbn: [lower, higher].sort()[0],
    openLibraryWorkKey: '/works/OL42W',
    coverImageUrl: 'https://covers.openlibrary.org/b/id/42-L.jpg?default=false',
    publicationYear: 1979,
  });
  const withoutYear = mapCandidateToBook({
    workKey: '/works/OL43W',
    title: 'Kindred',
    primaryAuthor: 'Octavia Butler',
    isbns: [],
    coverIds: [1],
    publicationYear: 0,
  });
  assert.equal(withoutYear.book.isbn, null);
  assert.equal(Object.hasOwn(withoutYear.book, 'publicationYear'), false);
  assert.equal(candidateImportSkipReason({ title: '!!!', primaryAuthor: 'Octavia Butler' }), 'missing_title');
  assert.equal(candidateImportSkipReason({ title: 'Kindred', primaryAuthor: '!!!' }), 'missing_author');
  assert.equal(candidateImportSkipReason({ title: 'Kindred', primaryAuthor: null }), 'missing_author');
  assert.equal(candidateImportSkipReason({ title: '   ', primaryAuthor: 'Octavia Butler' }), 'missing_title');
  assert.equal(candidateImportSkipReason({ title: '戦争と平和', primaryAuthor: 'Leo Tolstoy' }), 'unsupported_script');
  assert.equal(candidateImportSkipReason({ title: '\u0000\u0001', primaryAuthor: 'Octavia Butler' }), 'missing_title');
  const longTitle = `T${'a'.repeat(CATALOG_IMPORT_TITLE_MAX_LENGTH + 50)}`;
  const longAuthor = `A${'b'.repeat(CATALOG_IMPORT_AUTHOR_MAX_LENGTH + 50)}`;
  const sanitized = mapCandidateToBook({
    workKey: '/works/OL44W',
    title: `Kindred\u0000\u0001 ${longTitle.slice(1)}`,
    primaryAuthor: `\uD800Octavia\uDFFF ${longAuthor.slice(1)}`,
    isbns: [],
    coverIds: [1],
  });
  assert.equal(sanitized.book.title.length, CATALOG_IMPORT_TITLE_MAX_LENGTH);
  assert.equal(sanitized.book.author.length, CATALOG_IMPORT_AUTHOR_MAX_LENGTH);
  assert.equal(sanitized.book.title.includes('\u0000'), false);
  assert.equal(sanitized.book.author.includes('\uD800'), false);
  assert.equal(sanitized.book.author.includes('\uDFFF'), false);
  const emoji = mapCandidateToBook({
    workKey: '/works/OL45W',
    title: 'Kindred \uD83D\uDE00',
    primaryAuthor: 'Jane \uD83D\uDE00 Austen',
    isbns: [],
    coverIds: [1],
  });
  assert.equal(emoji.book.title, 'Kindred 😀');
  assert.equal(emoji.book.author, 'Jane 😀 Austen');
  const broken = mapCandidateToBook({
    workKey: '/works/OL46W',
    title: 'Line\nBreak',
    primaryAuthor: 'Tab\tAuthor',
    isbns: [],
    coverIds: [1],
  });
  assert.equal(broken.book.title, 'Line Break');
  assert.equal(broken.book.author, 'Tab Author');
  const spaced = mapCandidateToBook({
    workKey: '/works/OL47W',
    title: 'Line\r\n\tBreak',
    primaryAuthor: 'Ann\nLee',
    isbns: [],
    coverIds: [1],
  });
  assert.equal(spaced.book.title, 'Line Break');
  assert.equal(spaced.book.author, 'Ann Lee');
});

test('import skips existing, ambiguous, missing identity, duplicates, and rows past the limit', async () => {
  const isbn1 = isbnAt(31);
  const isbn2 = isbnAt(32);
  const isbn3 = isbnAt(33);
  const isbn4 = isbnAt(34);
  const candidates = [
    enrichedCandidate({ workKey: key(1), title: 'Existing', isbns: [isbnAt(41)] }),
    enrichedCandidate({ workKey: key(2), title: 'Ambiguous', isbns: [isbnAt(42)] }),
    enrichedCandidate({ workKey: key(3), title: 'No Author', primaryAuthor: null }),
    enrichedCandidate({ workKey: key(4), title: 'Punctuation', primaryAuthor: '!!!' }),
    enrichedCandidate({ workKey: key(5), title: 'First', isbns: [isbn1] }),
    enrichedCandidate({ workKey: key(6), title: 'Isbn Clash', isbns: [isbn2] }),
    enrichedCandidate({ workKey: key(7), title: 'Work Key Clash', isbns: [isbn3] }),
    enrichedCandidate({ workKey: key(8), title: 'Second', isbns: [isbn4] }),
    enrichedCandidate({ workKey: key(9), title: 'Over Limit', isbns: [isbnAt(35)] }),
  ];
  const artifact = enrichedArtifact(candidates, SNAPSHOT_ID, 'passed');
  const reportRows = [
    reportRow(candidates[0], 'existing'),
    reportRow(candidates[1], 'ambiguous', { matchedBy: 'isbn', matchedBookIds: ['a', 'b'] }),
    reportRow(candidates[2]),
    reportRow(candidates[3]),
    reportRow(candidates[4]),
    reportRow(candidates[5]),
    reportRow(candidates[6]),
    reportRow(candidates[7]),
    reportRow(candidates[8]),
  ];
  const confirmation = new Map([
    ['/works/OL1W', { id: 'pre-isbn', openLibraryWorkKey: '/works/OL1W', isbn: isbn2 }],
    [key(7), { id: 'pre-key', openLibraryWorkKey: key(7), isbn: isbnAt(99) }],
  ]);
  const writes = [];
  const createManyCalls = [];
  const db = {
    book: {
      findMany: async () => {
        writes.push('outer-findMany');
        throw new Error('apply must re-check inside the batch transaction');
      },
      createMany: async () => {
        writes.push('createMany');
        throw new Error('createMany must run on the transaction client');
      },
    },
    $transaction: async work => work({
      book: {
        findMany: async ({ where } = {}) => {
          const rows = [...confirmation.values()];
          if (!where?.OR) return rows;
          return rows.filter(book => where.OR.some(clause => (
            clause.openLibraryWorkKey?.in?.includes(book.openLibraryWorkKey)
            || clause.isbn?.in?.includes(book.isbn)
          )));
        },
        createMany: async ({ data, skipDuplicates }) => {
          createManyCalls.push({
            skipDuplicates,
            workKeys: data.map(row => row.openLibraryWorkKey),
          });
          for (const row of data) confirmation.set(row.openLibraryWorkKey, row);
          return { count: data.length };
        },
      },
    }),
  };

  const { summary, rows } = await importCatalogWorks({
    db,
    reportRows,
    artifact,
    apply: true,
    limit: 4,
    batchSize: 2,
  });
  assert.deepEqual(writes, []);
  assert.deepEqual(createManyCalls.map(call => call.workKeys), [[key(5)], [key(8)]]);
  assert.equal(createManyCalls.every(call => call.skipDuplicates === true), true);
  assert.equal(summary.batches, 2);
  assert.equal(summary.inserted, 2);
  assert.equal(summary.planned, 0);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.skipped, skipCounts({
    existing: 1,
    ambiguous: 1,
    missing_author: 2,
    duplicate_work_key: 1,
    duplicate_isbn: 1,
    limit: 1,
  }));
  assert.deepEqual(rows.map(row => [row.workKey, row.action, row.reason]), [
    [key(1), 'skip', 'existing'],
    [key(2), 'skip', 'ambiguous'],
    [key(3), 'skip', 'missing_author'],
    [key(4), 'skip', 'missing_author'],
    [key(5), 'insert', null],
    [key(6), 'skip', 'duplicate_isbn'],
    [key(7), 'skip', 'duplicate_work_key'],
    [key(8), 'insert', null],
    [key(9), 'skip', 'limit'],
  ]);
});

test('dry-run plans batches without write calls and records zero inserts', async () => {
  const candidates = [1, 2, 3, 4, 5].map(index => enrichedCandidate({
    workKey: key(index),
    title: `Plan ${index}`,
    isbns: [isbnAt(50 + index)],
  }));
  const calls = [];
  const db = {
    book: {
      findMany: async () => {
        calls.push('findMany');
        return [];
      },
      create: async () => { calls.push('create'); },
      createMany: async () => { calls.push('createMany'); },
      update: async () => { calls.push('update'); },
      updateMany: async () => { calls.push('updateMany'); },
      upsert: async () => { calls.push('upsert'); },
      delete: async () => { calls.push('delete'); },
      deleteMany: async () => { calls.push('deleteMany'); },
    },
    $transaction: async () => { calls.push('$transaction'); },
    $executeRaw: async () => { calls.push('$executeRaw'); },
  };
  let hookCalls = 0;
  const directory = await temporaryDirectory();
  const outputPath = join(directory, 'plan.jsonl');
  const { summary, rows, exitCode } = await importCatalogWorks({
    db,
    reportRows: candidates.map(candidate => reportRow(candidate)),
    artifact: enrichedArtifact(candidates),
    apply: false,
    limit: 4,
    batchSize: 2,
    outputPath,
    afterBatchInsert: async () => { hookCalls += 1; },
  });
  assert.deepEqual(calls, ['findMany', 'findMany']);
  assert.equal(hookCalls, 0);
  assert.equal(exitCode, 0);
  assert.equal(summary.mode, 'dry-run');
  assert.equal(summary.snapshotId, SNAPSHOT_ID);
  assert.equal(summary.languageCheck, 'pending');
  assert.equal(summary.report, outputPath);
  assert.equal(summary.limit, 4);
  assert.equal(summary.batchSize, 2);
  assert.equal(summary.batches, 2);
  assert.equal(summary.planned, 4);
  assert.equal(summary.inserted, 0);
  assert.equal(summary.skipped.limit, 1);
  assert.equal(rows.filter(row => row.action === 'plan').length, 4);
  assert.equal(rows.some(row => row.action === 'insert'), false);
  const written = (await fs.readFile(outputPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(written, rows);
  const summaryFile = JSON.parse(await fs.readFile(catalogImportSummaryPath(outputPath), 'utf8'));
  assert.equal(summaryFile.inserted, 0);
  assert.equal(summaryFile.planned, 4);
  assert.equal(summaryFile.languageCheck, 'pending');
  assert.equal(summaryFile.report, outputPath);
});

test('a repeated ISBN inside one batch is skipped before insert', async () => {
  const shared = isbnAt(61);
  const candidates = [
    enrichedCandidate({ workKey: key(21), title: 'Keeps ISBN', isbns: [shared] }),
    enrichedCandidate({ workKey: key(22), title: 'Drops ISBN', isbns: [shared] }),
  ];
  const { summary, rows } = await importCatalogWorks({
    db: { book: { findMany: async () => [] } },
    reportRows: candidates.map(candidate => reportRow(candidate)),
    artifact: enrichedArtifact(candidates),
    apply: false,
    limit: 2,
    batchSize: 10,
  });
  assert.equal(summary.planned, 1);
  assert.equal(summary.skipped.duplicate_isbn, 1);
  assert.deepEqual(rows.map(row => row.action), ['plan', 'skip']);
  assert.equal(rows[1].reason, 'duplicate_isbn');
});

test('a failed batch is recorded and later batches still run', async () => {
  const candidates = [1, 2, 3].map(index => enrichedCandidate({
    workKey: key(30 + index),
    title: `Batch ${index}`,
    isbns: [isbnAt(70 + index)],
  }));
  let transactions = 0;
  const db = {
    $transaction: async work => {
      transactions += 1;
      if (transactions === 2) throw new Error('injected batch failure');
      const stored = [];
      return work({
        book: {
          async findMany() {
            return stored;
          },
          async createMany({ data }) {
            stored.push(...data);
            return { count: data.length };
          },
        },
      });
    },
  };
  const { summary, rows, exitCode } = await importCatalogWorks({
    db,
    reportRows: candidates.map(candidate => reportRow(candidate)),
    artifact: enrichedArtifact(candidates, SNAPSHOT_ID, 'passed'),
    apply: true,
    limit: 3,
    batchSize: 1,
  });
  assert.equal(transactions, 3);
  assert.equal(exitCode, 1);
  assert.equal(summary.inserted, 2);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.errors, [{ workKey: candidates[1].workKey, error: 'injected batch failure' }]);
  assert.deepEqual(rows.map(row => row.action), ['insert', 'fail', 'insert']);
});

test('join rejects a report that does not match the enriched snapshot before any database call', async () => {
  const candidate = enrichedCandidate({ workKey: key(70), title: 'Snapshot Book' });
  const artifact = enrichedArtifact([candidate]);
  const db = { book: { findMany: async () => { throw new Error('database must not be called'); } } };
  const mismatchedKey = [reportRow(candidate)];
  mismatchedKey[0] = { ...mismatchedKey[0], workKey: key(71) };
  await assert.rejects(
    () => importCatalogWorks({ db, reportRows: mismatchedKey, artifact, apply: false }),
    error => error instanceof CatalogContractError && error.code === 'snapshot_mismatch',
  );
  const mismatchedSnapshot = [reportRow(candidate, 'new', { snapshotId: 'other-snapshot' })];
  await assert.rejects(
    () => importCatalogWorks({ db, reportRows: mismatchedSnapshot, artifact, apply: true }),
    error => error instanceof CatalogContractError && error.code === 'snapshot_mismatch',
  );
  const matched = [reportRow(candidate, 'new', { snapshotId: SNAPSHOT_ID })];
  const { summary } = await importCatalogWorks({
    db: { book: { findMany: async () => [] } },
    reportRows: matched,
    artifact,
    apply: false,
    limit: 1,
    batchSize: 1,
  });
  assert.equal(summary.planned, 1);
});

test('writeCatalogImportReport keeps the previous summary when validation fails', async () => {
  const directory = await temporaryDirectory();
  const outputPath = join(directory, 'import.jsonl');
  const rows = [{ workKey: key(80), action: 'plan', reason: null, error: null }];
  const summary = {
    mode: 'dry-run',
    snapshotId: SNAPSHOT_ID,
    languageCheck: 'pending',
    limit: 1,
    batchSize: 1,
    batches: 1,
    planned: 1,
    inserted: 0,
    skipped: skipCounts(),
    failed: 0,
    errors: [],
    report: outputPath,
  };
  await writeCatalogImportReport(outputPath, { rows, summary });
  const summaryPath = catalogImportSummaryPath(outputPath);
  const before = await fs.readFile(summaryPath, 'utf8');
  await assert.rejects(
    () => writeCatalogImportReport(outputPath, { rows, summary: { ...summary, inserted: 4 } }),
    error => error instanceof CatalogContractError && error.code === 'invalid_import_report',
  );
  assert.equal(await fs.readFile(summaryPath, 'utf8'), before);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.includes('.tmp') || name.includes('.bak')), []);
});

test('works import defaults and the read-only client expose no write methods', async () => {
  const parsed = parseCatalogWorksImportArgs([
    '--report', 'report.jsonl',
    '--enriched', 'enriched.json',
    '--output', 'out.jsonl',
  ]);
  assert.equal(parsed.apply, false);
  assert.equal(parsed.allowUncheckedLanguage, false);
  assert.equal(parsed.limit, CATALOG_IMPORT_DEFAULT_LIMIT);
  assert.equal(parsed.batchSize, CATALOG_IMPORT_DEFAULT_BATCH_SIZE);
  assert.equal(parsed.report.endsWith(`${join('report.jsonl')}`), true);
  await assert.rejects(
    async () => parseCatalogWorksImportArgs(['--report', 'r', '--enriched', 'e', '--output', 'o', '--limit', '10001']),
    error => error instanceof Error && error.message === '--limit must be an integer from 1 through 10000',
  );
  const db = createImportPrismaClient('postgresql://bookish:bookish@127.0.0.1:1/bookish_test', { apply: false });
  assert.equal(db.book.createMany, undefined);
  assert.equal(db.book.create, undefined);
  assert.equal(db.$transaction, undefined);
  assert.equal(typeof db.book.findMany, 'function');
  assert.equal(typeof db.$disconnect, 'function');
  await db.$disconnect();
});

test('catalog:import parses works-import arguments before connecting and keeps the resolved-artifact mode', async () => {
  const source = await fs.readFile(SCRIPT, 'utf8');
  assert.equal(source.startsWith("import 'dotenv/config';\n"), true);
  assert.equal(source.includes('process.env.DATABASE_URL'), true);
  assert.equal(source.includes('src/config/env.js'), false);
  assert.match(source, /await import\('\.\.\/src\/lib\/prisma\.js'\)/);
  await assert.rejects(
    () => execFileAsync(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH } }),
    error => error.code === 1 && error.stderr.includes('Choose exactly one mode: --dry-run or --apply'),
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [SCRIPT, '--report', 'report.jsonl', '--limit', '10001'], {
      env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/bookish_test' },
    }),
    error => error.code === 1
      && error.stderr.includes('--limit must be an integer from 1 through 10000')
      && !/ECONNREFUSED|Can't reach database server/.test(error.stderr),
  );
});

test('catalog:import reads DATABASE_URL from .env for the works import', async () => {
  const directory = await temporaryDirectory();
  const candidate = enrichedCandidate({ workKey: key(90), title: 'Dotenv Book', isbns: [isbnAt(90)] });
  const artifactPath = join(directory, 'enriched.json');
  const reportPath = join(directory, 'report.jsonl');
  const outputPath = join(directory, 'out.jsonl');
  await fs.writeFile(artifactPath, `${JSON.stringify(enrichedArtifact([candidate]))}\n`, 'utf8');
  await fs.writeFile(reportPath, `${JSON.stringify(reportRow(candidate))}\n`, 'utf8');
  await fs.writeFile(join(directory, '.env'), 'DATABASE_URL=postgresql://dotenv-test:dotenv-test@127.0.0.1:1/dotenv_test\n');
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      SCRIPT,
      '--report', reportPath,
      '--enriched', artifactPath,
      '--output', outputPath,
      '--limit', '1',
    ], {
      cwd: directory,
      env: { PATH: process.env.PATH },
    }),
    error => error.code === 1
      && !`${error.stderr}${error.stdout}`.includes('DATABASE_URL is required')
      && /Can't reach database server at 127\.0\.0\.1:1/.test(`${error.stdout}`),
  );
});

function trackingDb() {
  const stored = [];
  const matches = ({ where } = {}) => {
    if (!where?.OR) return [...stored];
    return stored.filter(book => where.OR.some(clause => (
      clause.openLibraryWorkKey?.in?.includes(book.openLibraryWorkKey)
      || clause.isbn?.in?.includes(book.isbn)
    )));
  };
  return {
    book: { findMany: async query => matches(query) },
    $transaction: async work => work({
      book: {
        findMany: async query => matches(query),
        createMany: async ({ data }) => {
          stored.push(...data);
          return { count: data.length };
        },
      },
    }),
  };
}

test('dry-run and apply count a later-batch duplicate ISBN the same way', async () => {
  const shared = isbnAt(120);
  const candidates = [0, 1, 2].map(index => enrichedCandidate({
    workKey: key(120 + index),
    title: `Seen ${index}`,
    isbns: [index === 0 ? shared : isbnAt(130 + index)],
  }));
  candidates.push(enrichedCandidate({
    workKey: key(123),
    title: 'Later Duplicate',
    isbns: [shared],
  }));
  const artifact = enrichedArtifact(candidates, SNAPSHOT_ID, 'passed');
  const reportRows = candidates.map(candidate => reportRow(candidate));
  const dry = await importCatalogWorks({
    db: trackingDb(),
    reportRows,
    artifact,
    apply: false,
    limit: 10,
    batchSize: 3,
  });
  const applied = await importCatalogWorks({
    db: trackingDb(),
    reportRows,
    artifact,
    apply: true,
    limit: 10,
    batchSize: 3,
  });
  assert.equal(dry.summary.planned, 3);
  assert.equal(applied.summary.inserted, 3);
  assert.equal(dry.summary.skipped.duplicate_isbn, 1);
  assert.equal(applied.summary.skipped.duplicate_isbn, 1);
  assert.deepEqual(dry.summary.skipped, applied.summary.skipped);
  assert.deepEqual(dry.rows.map(row => row.reason), applied.rows.map(row => row.reason));
  assert.equal(dry.rows.at(-1).action, 'skip');
  assert.equal(applied.rows.at(-1).action, 'skip');
});

test('apply refuses an unchecked language and dry-run reports it', async () => {
  const candidate = enrichedCandidate({ workKey: key(140), title: 'Unchecked Language', isbns: [isbnAt(140)] });
  const calls = [];
  const db = {
    book: {
      findMany: async () => {
        calls.push('findMany');
        return [];
      },
    },
    $transaction: async () => { calls.push('transaction'); },
  };
  await assert.rejects(
    async () => importCatalogWorks({
      db,
      reportRows: [reportRow(candidate)],
      artifact: enrichedArtifact([candidate]),
      apply: true,
    }),
    error => error instanceof Error
      && error.message.includes('Refusing --apply')
      && error.message.includes('not "passed"')
      && error.message.includes('--allow-unchecked-language'),
  );
  assert.deepEqual(calls, []);
  const dry = await importCatalogWorks({
    db,
    reportRows: [reportRow(candidate)],
    artifact: enrichedArtifact([candidate]),
    apply: false,
  });
  assert.equal(dry.summary.languageCheck, 'pending');
  assert.equal(dry.summary.planned, 1);
  assert.deepEqual(calls, ['findMany']);
});

test('--allow-unchecked-language permits apply and prints a warning', async () => {
  const candidate = enrichedCandidate({ workKey: key(141), title: 'Language Override', isbns: [isbnAt(141)] });
  const checked = enrichedCandidate({ workKey: key(142), title: 'Language Passed', isbns: [isbnAt(142)] });
  const warnings = [];
  const original = console.error;
  console.error = (...parts) => { warnings.push(parts.map(String).join(' ')); };
  try {
    const overridden = await importCatalogWorks({
      db: trackingDb(),
      reportRows: [reportRow(candidate)],
      artifact: enrichedArtifact([candidate]),
      apply: true,
      allowUncheckedLanguage: true,
    });
    assert.equal(overridden.summary.inserted, 1);
    assert.equal(overridden.summary.languageCheck, 'pending');
    const quiet = [];
    console.error = (...parts) => { quiet.push(parts.map(String).join(' ')); };
    const passed = await importCatalogWorks({
      db: trackingDb(),
      reportRows: [reportRow(checked)],
      artifact: enrichedArtifact([checked], SNAPSHOT_ID, 'passed'),
      apply: true,
    });
    assert.equal(passed.summary.inserted, 1);
    assert.equal(passed.summary.languageCheck, 'passed');
    assert.deepEqual(quiet, []);
  } finally {
    console.error = original;
  }
  assert.match(warnings.join('\n'), /WARNING: --allow-unchecked-language/);
});

test('non-books are skipped with pilotDisqualificationReason and do not consume the limit', async () => {
  const audio = enrichedCandidate({ workKey: key(150), title: 'Book (Audiobook)', isbns: [isbnAt(150)] });
  const real = enrichedCandidate({ workKey: key(151), title: 'Real Book', isbns: [isbnAt(151)] });
  const { summary, rows } = await importCatalogWorks({
    db: { book: { findMany: async () => [] } },
    reportRows: [reportRow(audio), reportRow(real)],
    artifact: enrichedArtifact([audio, real]),
    apply: false,
    limit: 1,
    batchSize: 10,
  });
  assert.equal(rows[0].reason, 'audiobook');
  assert.equal(rows[1].action, 'plan');
  assert.equal(summary.skipped.audiobook, 1);
  assert.equal(summary.skipped.limit, 0);
  assert.equal(summary.planned, 1);
});

test('catalog:import refuses --apply until languageCheck is passed', async () => {
  const directory = await temporaryDirectory();
  const candidate = enrichedCandidate({ workKey: key(160), title: 'Pending Apply', isbns: [isbnAt(160)] });
  const artifactPath = join(directory, 'enriched.json');
  const reportPath = join(directory, 'report.jsonl');
  const outputPath = join(directory, 'out.jsonl');
  await fs.writeFile(artifactPath, `${JSON.stringify(enrichedArtifact([candidate]))}\n`);
  await fs.writeFile(reportPath, `${JSON.stringify(reportRow(candidate))}\n`);
  const env = {
    PATH: process.env.PATH,
    DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/bookish_test',
  };
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      SCRIPT, '--report', reportPath, '--enriched', artifactPath, '--output', outputPath, '--apply',
    ], { env }),
    error => error.code === 1
      && error.stderr.includes('Refusing --apply')
      && !/Can't reach database server|ECONNREFUSED/.test(`${error.stdout}${error.stderr}`),
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      SCRIPT,
      '--report', reportPath,
      '--enriched', artifactPath,
      '--output', outputPath,
      '--apply',
      '--allow-unchecked-language',
    ], { env }),
    error => error.code === 1
      && /WARNING: --allow-unchecked-language/.test(error.stderr)
      && /Can't reach database server at 127\.0\.0\.1:1/.test(error.stdout),
  );
});

test('catalog:import checks the output directory before connecting', { skip: process.getuid?.() === 0 }, async () => {
  const directory = await temporaryDirectory();
  const locked = join(directory, 'locked');
  await fs.mkdir(locked);
  await fs.chmod(locked, 0o000);
  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [
        SCRIPT,
        '--report', join(directory, 'report.jsonl'),
        '--enriched', join(directory, 'enriched.json'),
        '--output', join(locked, 'out.jsonl'),
      ], {
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/bookish_test',
        },
      }),
      error => error.code === 1
        && error.stderr.includes(`Import output directory is not writable: ${locked}`)
        && !/Can't reach database server|ECONNREFUSED|Unable to read/.test(`${error.stdout}${error.stderr}`),
    );
  } finally {
    await fs.chmod(locked, 0o755);
  }
});
