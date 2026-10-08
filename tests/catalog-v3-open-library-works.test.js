import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildOpenLibraryWorkIndex, createOpenLibraryWorkLookup } from '../scripts/catalog/open-library-works.js';
import { buildLegacyWorkIndex } from './helpers/open-library-work-index-legacy.js';

const WORKS = new URL('./fixtures/open-library-works.txt', import.meta.url);
const RATINGS = new URL('./fixtures/open-library-ratings.txt', import.meta.url);
const READING_LOG = new URL('./fixtures/open-library-reading-log.txt', import.meta.url);
const SNAPSHOT_ID = 'open-library-2026-08-31';
const GENERATED_AT = '2026-08-31T00:00:00.000Z';
const execFileAsync = promisify(execFile);
const originalFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = () => { throw new Error('network access is forbidden'); };
});

after(() => {
  globalThis.fetch = originalFetch;
});

function zeroReadingLog() {
  return { 'Want to Read': 0, 'Currently Reading': 0, 'Already Read': 0 };
}

async function temporaryDirectory() {
  return fs.mkdtemp(join(tmpdir(), 'bookish-ol-works-'));
}

async function artifactDigest(outputPath) {
  const indexJson = await fs.readFile(join(outputPath, 'index.json'), 'utf8');
  const sqlite = await fs.readFile(join(outputPath, 'works.sqlite'));
  const lookup = await createOpenLibraryWorkLookup({ indexPath: outputPath, snapshotId: SNAPSHOT_ID });
  const records = [];
  lookup.forEachWork(row => records.push(lookup.get(row.key)));
  lookup.close();
  records.sort((left, right) => left.workKey.localeCompare(right.workKey));
  return {
    indexJson,
    sqliteSha256: createHash('sha256').update(sqlite).digest('hex'),
    records,
  };
}

async function buildFixture(directory, options = {}) {
  const outputPath = join(directory, 'works-index');
  const progress = [];
  progress.validating = 0;
  const result = await buildOpenLibraryWorkIndex({
    worksPath: fileURLToPath(WORKS),
    ratingsPath: fileURLToPath(RATINGS),
    readingLogPath: fileURLToPath(READING_LOG),
    outputPath,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
    batchSize: 1,
    progressInterval: 1,
    onProgress: (statistics, phase) => {
      if (phase === 'validating') progress.validating += 1;
      else progress.push(statistics);
    },
    ...options,
  });
  const lookup = await createOpenLibraryWorkLookup({ indexPath: outputPath, snapshotId: SNAPSHOT_ID });
  return { outputPath, result, lookup, progress };
}

test('works index stores fields, deterministic duplicates, ratings, shelves, and orphan signals', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { outputPath, result, lookup, progress } = await buildFixture(directory);
  t.after(() => lookup.close());

  assert.equal(result.format, 'bookish-open-library-work-index');
  assert.equal(result.indexVersion, 1);
  assert.equal(result.sourceName, 'open-library-bulk');
  assert.equal(result.snapshotId, SNAPSHOT_ID);
  assert.equal(result.generatedAt, GENERATED_AT);
  assert.equal(result.outputPath, outputPath);
  assert.deepEqual(result.statistics, {
    works: {
      input: 15,
      accepted: 4,
      rejected: 7,
      duplicates: 4,
      rejectedByReason: { malformed_row: 3, invalid_json: 1, wrong_type: 1, missing_title: 2 },
    },
    ratings: {
      input: 16,
      accepted: 4,
      rejected: 11,
      orphans: 1,
      rejectedByReason: { malformed_row: 6, non_integer: 3, out_of_range: 2 },
    },
    readingLog: {
      input: 14,
      accepted: 6,
      rejected: 7,
      orphans: 1,
      rejectedByReason: { malformed_row: 5, unknown_shelf: 2 },
    },
  });
  assert.equal(progress.length, 15 + 2 + 16 + 3 + 14 + 3);
  assert.ok(progress.validating >= 1);
  assert.deepEqual(progress.at(-1), result.statistics);
  const metadata = JSON.parse(await fs.readFile(join(outputPath, 'index.json'), 'utf8'));
  assert.deepEqual(metadata.statistics, result.statistics);
  assert.equal((await fs.readdir(directory)).some(name => name.includes('.building-')), false);

  assert.deepEqual(lookup.get('/works/OL10W'), {
    workKey: '/works/OL10W',
    title: 'Pride and Prejudice',
    subtitle: 'A Novel',
    authorKeys: ['/authors/OL1A', '/authors/OL2A'],
    subjects: ['Fiction', 'Romance'],
    coverIds: [123, 456],
    firstPublishDate: '1813',
    description: 'A classic.',
    ratingsCount: 3,
    ratingsSum: 10,
    readingLog: { 'Want to Read': 2, 'Currently Reading': 1, 'Already Read': 2 },
  });
  assert.deepEqual(lookup.get('/works/OL12W'), {
    workKey: '/works/OL12W',
    title: 'Emma',
    subtitle: null,
    authorKeys: [],
    subjects: [],
    coverIds: [],
    firstPublishDate: 'January 1813',
    description: 'Plain text.',
    ratingsCount: 1,
    ratingsSum: 3,
    readingLog: { ...zeroReadingLog(), 'Already Read': 1 },
  });
  assert.equal(lookup.get('/works/OL11W').title, 'Later tie');
  assert.deepEqual(lookup.get('/works/OL11W').readingLog, zeroReadingLog());
  assert.equal(lookup.get('/works/OL11W').ratingsCount, 0);
  assert.equal(lookup.get('/works/OL14W').title, 'High rev');
  assert.equal(lookup.get('/works/OL999W'), null);
  assert.equal(lookup.get('/works/OL888W'), null);
  assert.equal(lookup.get('/works/OL20W'), null);
});

test('gzip-compressed inputs produce the same works index without network access', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plain = await buildFixture(join(directory, 'plain'));
  const gzipDirectory = join(directory, 'gzip');
  await fs.mkdir(gzipDirectory);
  const worksPath = join(gzipDirectory, 'works.txt.gz');
  const ratingsPath = join(gzipDirectory, 'ratings.txt.gz');
  const readingLogPath = join(gzipDirectory, 'reading-log.txt.gz');
  await fs.writeFile(worksPath, gzipSync(await fs.readFile(fileURLToPath(WORKS))));
  await fs.writeFile(ratingsPath, gzipSync(await fs.readFile(fileURLToPath(RATINGS))));
  await fs.writeFile(readingLogPath, gzipSync(await fs.readFile(fileURLToPath(READING_LOG))));
  const gzipOutput = join(gzipDirectory, 'works-index');
  const gzipResult = await buildOpenLibraryWorkIndex({
    worksPath,
    ratingsPath,
    readingLogPath,
    outputPath: gzipOutput,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
    batchSize: 2,
  });
  const gzipLookup = await createOpenLibraryWorkLookup({ indexPath: gzipOutput, snapshotId: SNAPSHOT_ID });
  t.after(() => {
    plain.lookup.close();
    gzipLookup.close();
  });
  assert.deepEqual(gzipResult.statistics, plain.result.statistics);
  for (const key of ['/works/OL10W', '/works/OL11W', '/works/OL12W', '/works/OL14W']) {
    assert.deepEqual(gzipLookup.get(key), plain.lookup.get(key));
  }
});

test('several thousand local work rows stream through the index without an input array', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const worksPath = join(directory, 'works.txt');
  const ratingsPath = join(directory, 'ratings.txt');
  const readingLogPath = join(directory, 'reading-log.txt');
  const works = await fs.open(worksPath, 'w');
  const ratings = await fs.open(ratingsPath, 'w');
  const readingLog = await fs.open(readingLogPath, 'w');
  const total = 3000;
  const shelves = ['Want to Read', 'Currently Reading', 'Already Read'];
  try {
    for (let index = 0; index < total; index += 1) {
      const payload = JSON.stringify({ title: `Synthetic Work ${index}` });
      await works.writeFile(`/type/work\t/works/OL${index}W\t1\t2026-01-01T00:00:00.000000\t${payload}\n`);
      await ratings.writeFile(`/works/OL${index}W\t\\N\t${(index % 5) + 1}\t2026-01-01\n`);
      await readingLog.writeFile(`/works/OL${index}W\t\\N\t${shelves[index % 3]}\t2026-01-01\n`);
    }
    await works.writeFile('not a dump row\n');
    await ratings.writeFile('/works/OL999999W\t\\N\t5\t2026-01-01\n');
    await readingLog.writeFile('/works/OL1W\t\\N\tStopped Reading\t2026-01-01\n');
  } finally {
    await works.close();
    await ratings.close();
    await readingLog.close();
  }
  const outputPath = join(directory, 'works-index');
  const result = await buildOpenLibraryWorkIndex({
    worksPath,
    ratingsPath,
    readingLogPath,
    outputPath,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
    batchSize: 100,
  });
  assert.equal(result.statistics.works.accepted, total);
  assert.equal(result.statistics.works.rejected, 1);
  assert.equal(result.statistics.ratings.accepted, total);
  assert.equal(result.statistics.ratings.orphans, 1);
  assert.equal(result.statistics.readingLog.accepted, total);
  assert.equal(result.statistics.readingLog.rejected, 1);
  const lookup = await createOpenLibraryWorkLookup({ indexPath: outputPath, snapshotId: SNAPSHOT_ID });
  t.after(() => lookup.close());
  const target = 2431;
  assert.deepEqual(lookup.get(`/works/OL${target}W`), {
    workKey: `/works/OL${target}W`,
    title: `Synthetic Work ${target}`,
    subtitle: null,
    authorKeys: [],
    subjects: [],
    coverIds: [],
    firstPublishDate: null,
    description: null,
    ratingsCount: 1,
    ratingsSum: (target % 5) + 1,
    readingLog: {
      'Want to Read': target % 3 === 0 ? 1 : 0,
      'Currently Reading': target % 3 === 1 ? 1 : 0,
      'Already Read': target % 3 === 2 ? 1 : 0,
    },
  });
});

test('lookup rejects a missing, corrupt, or snapshot-mismatched works index without fallback', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { outputPath, lookup } = await buildFixture(directory);
  lookup.close();
  await assert.rejects(
    createOpenLibraryWorkLookup({ indexPath: outputPath, snapshotId: 'other-snapshot' }),
    error => error.code === 'work_snapshot_mismatch',
  );
  await assert.rejects(
    createOpenLibraryWorkLookup({ indexPath: join(directory, 'missing'), snapshotId: SNAPSHOT_ID }),
    error => error.code === 'invalid_work_index',
  );
  await fs.writeFile(join(outputPath, 'works.sqlite'), 'not a SQLite database');
  await assert.rejects(
    createOpenLibraryWorkLookup({ indexPath: outputPath, snapshotId: SNAPSHOT_ID }),
    error => error.code === 'invalid_work_index',
  );
});

test('a missing gzip input rejects and leaves no building directory', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { outputPath, lookup } = await buildFixture(directory);
  t.after(() => lookup.close());
  const before = lookup.get('/works/OL10W');
  const build = (ratingsPath, readingLogPath) => buildOpenLibraryWorkIndex({
    worksPath: fileURLToPath(WORKS),
    ratingsPath,
    readingLogPath,
    outputPath,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
  });
  await assert.rejects(
    build(join(directory, 'missing-ratings.txt.gz'), fileURLToPath(READING_LOG)),
    error => error.code === 'invalid_argument',
  );
  await assert.rejects(
    build(fileURLToPath(RATINGS), join(directory, 'missing-reading-log.txt.gz')),
    error => error.code === 'invalid_argument',
  );
  const unreadableGzip = join(directory, 'ratings-dir.txt.gz');
  await fs.mkdir(unreadableGzip);
  await assert.rejects(build(unreadableGzip, fileURLToPath(READING_LOG)));
  assert.equal((await fs.readdir(directory)).some(name => name.includes('.building-')), false);
  assert.deepEqual(lookup.get('/works/OL10W'), before);
});

test('work keys that do not match /works/OL…W are rejected', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const worksPath = join(directory, 'works.txt');
  const ratingsPath = join(directory, 'ratings.txt');
  const readingLogPath = join(directory, 'reading-log.txt');
  await fs.writeFile(worksPath, [
    '/type/work\t/works/NOTVALID\t1\t2026-01-01T00:00:00.000000\t{"title":"Bad key"}\n',
    '/type/work\t/works/OL1W\t1\t2026-01-01T00:00:00.000000\t{"title":"Good"}\n',
  ].join(''));
  await fs.writeFile(ratingsPath, '');
  await fs.writeFile(readingLogPath, '');
  const outputPath = join(directory, 'works-index');
  const result = await buildOpenLibraryWorkIndex({
    worksPath,
    ratingsPath,
    readingLogPath,
    outputPath,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
  });
  assert.equal(result.statistics.works.accepted, 1);
  assert.equal(result.statistics.works.rejected, 1);
  assert.equal(result.statistics.works.rejectedByReason.malformed_row, 1);
  const lookup = await createOpenLibraryWorkLookup({ indexPath: outputPath, snapshotId: SNAPSHOT_ID });
  t.after(() => lookup.close());
  assert.equal(lookup.get('/works/NOTVALID'), null);
  assert.equal(lookup.get('/works/OL1W').title, 'Good');
});

test('failed works index build preserves an existing known-good artifact', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { outputPath, lookup } = await buildFixture(directory);
  t.after(() => lookup.close());
  const before = lookup.get('/works/OL10W');
  await assert.rejects(buildOpenLibraryWorkIndex({
    worksPath: fileURLToPath(WORKS),
    ratingsPath: join(directory, 'missing-ratings.txt'),
    readingLogPath: fileURLToPath(READING_LOG),
    outputPath,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
    batchSize: 1,
  }));
  assert.deepEqual(lookup.get('/works/OL10W'), before);
  assert.equal((await fs.readdir(directory)).some(name => name.includes('.building-')), false);
  const reopened = await createOpenLibraryWorkLookup({ indexPath: outputPath, snapshotId: SNAPSHOT_ID });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.get('/works/OL10W'), before);
  assert.equal(reopened.get('/works/OL11W').title, 'Later tie');
});

test('works index CLI prints a JSON summary and rejects missing or unknown arguments', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/ol-work-index-build.js', import.meta.url));
  const outputPath = join(directory, 'works-index');
  const success = await execFileAsync(process.execPath, [
    '--experimental-sqlite', script,
    '--works', fileURLToPath(WORKS),
    '--ratings', fileURLToPath(RATINGS),
    '--reading-log', fileURLToPath(READING_LOG),
    '--snapshot-id', SNAPSHOT_ID,
    '--output', outputPath,
    '--batch-size', '2',
    '--progress-interval', '5',
  ]);
  const summary = JSON.parse(success.stdout);
  assert.equal(summary.statistics.works.accepted, 4);
  assert.equal(summary.statistics.ratings.orphans, 1);
  assert.equal(summary.statistics.readingLog.rejectedByReason.unknown_shelf, 2);
  assert.equal(summary.snapshotId, SNAPSHOT_ID);
  assert.equal(summary.outputPath, outputPath);
  const lookup = await createOpenLibraryWorkLookup({ indexPath: outputPath, snapshotId: SNAPSHOT_ID });
  t.after(() => lookup.close());
  assert.equal(lookup.get('/works/OL10W').ratingsSum, 10);

  await assert.rejects(
    execFileAsync(process.execPath, ['--experimental-sqlite', script, '--snapshot-id', SNAPSHOT_ID]),
    error => error.code === 1 && error.stderr.includes('--works, --ratings, --reading-log, and --snapshot-id are required'),
  );
  await assert.rejects(
    execFileAsync(process.execPath, ['--experimental-sqlite', script, '--works', fileURLToPath(WORKS), '--not-a-flag']),
    error => error.code === 1 && error.stderr.includes('Unknown argument --not-a-flag'),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--experimental-sqlite', script,
      '--works', fileURLToPath(WORKS),
      '--ratings', fileURLToPath(RATINGS),
      '--reading-log', fileURLToPath(READING_LOG),
      '--snapshot-id', SNAPSHOT_ID,
      '--batch-size', '0',
    ]),
    error => error.code === 1 && error.stderr.includes('--batch-size must be a positive integer'),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--experimental-sqlite', script,
      '--works', fileURLToPath(WORKS),
      '--ratings', fileURLToPath(RATINGS),
      '--reading-log', fileURLToPath(READING_LOG),
      '--snapshot-id', SNAPSHOT_ID,
      '--cache-mb', '32',
    ]),
    error => error.code === 1 && error.stderr.includes('--cache-mb must be an integer from 64 through 16384'),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--experimental-sqlite', script,
      '--works', fileURLToPath(WORKS),
      '--ratings', fileURLToPath(RATINGS),
      '--reading-log', fileURLToPath(READING_LOG),
      '--snapshot-id', SNAPSHOT_ID,
      '--cache-mb', '1e3',
    ]),
    error => error.code === 1 && error.stderr.includes('--cache-mb must be a plain decimal integer'),
  );
});

test('truncated gzip input surfaces zlib error and leaves no building directory', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'works-index');
  const worksPath = join(directory, 'truncated.txt.gz');
  await fs.writeFile(worksPath, gzipSync('partial content').subarray(0, 8));
  await assert.rejects(
    buildOpenLibraryWorkIndex({
      worksPath,
      ratingsPath: fileURLToPath(RATINGS),
      readingLogPath: fileURLToPath(READING_LOG),
      outputPath,
      snapshotId: SNAPSHOT_ID,
      generatedAt: GENERATED_AT,
    }),
    error => /Z_BUF_ERROR|unexpected end of file|incorrect data check/i.test(error.message),
  );
  assert.equal((await fs.readdir(directory)).some(name => name.includes('.building-')), false);
});

test('staged works merge and aggregated signals match legacy reference output on fixtures', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const common = {
    worksPath: fileURLToPath(WORKS),
    ratingsPath: fileURLToPath(RATINGS),
    readingLogPath: fileURLToPath(READING_LOG),
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
    cacheMb: 64,
    batchSize: 2,
  };
  const legacyPath = join(directory, 'legacy');
  const optimizedPath = join(directory, 'optimized');
  await buildLegacyWorkIndex({ ...common, outputPath: legacyPath });
  await buildOpenLibraryWorkIndex({ ...common, outputPath: optimizedPath });
  const legacy = await artifactDigest(legacyPath);
  const optimized = await artifactDigest(optimizedPath);
  assert.equal(optimized.indexJson, legacy.indexJson);
  assert.deepEqual(optimized.records, legacy.records);
});

test('different cache sizes produce identical logical fixture artifacts', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const common = {
    worksPath: fileURLToPath(WORKS),
    ratingsPath: fileURLToPath(RATINGS),
    readingLogPath: fileURLToPath(READING_LOG),
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
    batchSize: 2,
  };
  await buildOpenLibraryWorkIndex({ ...common, outputPath: join(directory, 'small-cache'), cacheMb: 64 });
  await buildOpenLibraryWorkIndex({ ...common, outputPath: join(directory, 'large-cache'), cacheMb: 1024 });
  const small = await artifactDigest(join(directory, 'small-cache'));
  const large = await artifactDigest(join(directory, 'large-cache'));
  assert.equal(large.indexJson, small.indexJson);
  assert.deepEqual(large.records, small.records);
});

test('works index builder does not reference Prisma, the database URL, or fetch', async () => {
  const moduleSource = await fs.readFile(new URL('../scripts/catalog/open-library-works.js', import.meta.url), 'utf8');
  const cliSource = await fs.readFile(new URL('../scripts/ol-work-index-build.js', import.meta.url), 'utf8');
  for (const source of [moduleSource, cliSource]) {
    assert.equal(source.includes('prisma'), false);
    assert.equal(source.includes('DATABASE_URL'), false);
    assert.equal(source.includes('fetch('), false);
  }
});
