import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_DISCOVER_FORMAT,
  CATALOG_DISCOVER_SCORING,
  CATALOG_DISCOVER_VERSION,
  discoverCatalogCandidates,
  popularityScore,
  writeDiscoverArtifactAtomically,
} from '../scripts/catalog/discover.js';
import { buildOpenLibraryWorkIndex, createOpenLibraryWorkLookup } from '../scripts/catalog/open-library-works.js';

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

function workLine(key, data) {
  return `/type/work\t${key}\t1\t2026-01-01T00:00:00.000000\t${JSON.stringify(data)}\n`;
}

function repeat(line, count) {
  return Array.from({ length: count }, () => line).join('');
}

async function temporaryDirectory() {
  return fs.mkdtemp(join(tmpdir(), 'bookish-discover-'));
}

function readingLog(counts = {}) {
  return {
    'Want to Read': counts['Want to Read'] ?? 0,
    'Currently Reading': counts['Currently Reading'] ?? 0,
    'Already Read': counts['Already Read'] ?? 0,
  };
}

async function writeCopies(handle, line, count) {
  let buffer = '';
  for (let index = 0; index < count; index += 1) {
    buffer += line;
    if (buffer.length >= 1024 * 1024) {
      await handle.writeFile(buffer);
      buffer = '';
    }
  }
  if (buffer) await handle.writeFile(buffer);
}

async function mutateWorks(indexPath, statements) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(indexPath, 'works.sqlite'));
  try {
    for (const statement of statements) database.exec(statement);
  } finally {
    database.close();
  }
}

async function buildRankingIndex(directory) {
  const worksPath = join(directory, 'works.txt');
  const ratingsPath = join(directory, 'ratings.txt');
  const readingLogPath = join(directory, 'reading-log.txt');
  const works = [
    workLine('/works/OL100W', { title: 'Highest', covers: [11], authors: [{ author: { key: '/authors/OL9A' } }] }),
    workLine('/works/OL200W', { title: 'Tied Low Key', covers: [22] }),
    workLine('/works/OL300W', { title: 'Tied High Key', covers: [33] }),
    workLine('/works/OL400W', { title: 'Modest', covers: [44] }),
    workLine('/works/OL450W', { title: 'Boundary', covers: [45] }),
    workLine('/works/OL500W', { title: 'No Cover' }),
    workLine('/works/OL600W', { title: 'Unrated', covers: [66] }),
    workLine('/works/OL700W', { title: 'Unread', covers: [77] }),
    workLine('/works/OL800W', { title: 'Neither', covers: [88] }),
    workLine('/works/OL900W', { title: 'Excluded Popular', covers: [99], authors: [{ author: { key: '/authors/OL1A' } }] }),
    workLine('/works/OL1000W', { title: 'Blank Later', covers: [100] }),
    workLine('/works/OL1100W', { title: 'Bad Key Later', covers: [110] }),
    workLine('/works/OL1200W', { title: 'Spaces Later', covers: [120] }),
  ];
  const ratings = [
    repeat('/works/OL100W\t\\N\t5\t2026-01-01\n', 5),
    repeat('/works/OL200W\t\\N\t4\t2026-01-01\n', 4),
    repeat('/works/OL300W\t\\N\t4\t2026-01-01\n', 4),
    '/works/OL400W\t\\N\t3\t2026-01-01\n',
    '/works/OL450W\t\\N\t1\t2026-01-01\n',
    repeat('/works/OL500W\t\\N\t5\t2026-01-01\n', 8),
    repeat('/works/OL700W\t\\N\t5\t2026-01-01\n', 8),
    repeat('/works/OL900W\t\\N\t5\t2026-01-01\n', 10),
    '/works/OL1000W\t\\N\t5\t2026-01-01\n',
    '/works/OL1100W\t\\N\t5\t2026-01-01\n',
    '/works/OL1200W\t\\N\t5\t2026-01-01\n',
  ];
  const readingLog = [
    repeat('/works/OL100W\t\\N\tAlready Read\t2026-01-01\n', 40),
    repeat('/works/OL200W\t\\N\tAlready Read\t2026-01-01\n', 3),
    repeat('/works/OL300W\t\\N\tAlready Read\t2026-01-01\n', 3),
    '/works/OL400W\t\\N\tAlready Read\t2026-01-01\n',
    '/works/OL450W\t\\N\tWant to Read\t2026-01-01\n',
    repeat('/works/OL500W\t\\N\tAlready Read\t2026-01-01\n', 15),
    repeat('/works/OL600W\t\\N\tAlready Read\t2026-01-01\n', 5),
    repeat('/works/OL900W\t\\N\tAlready Read\t2026-01-01\n', 20),
    '/works/OL1000W\t\\N\tCurrently Reading\t2026-01-01\n',
    '/works/OL1100W\t\\N\tCurrently Reading\t2026-01-01\n',
    '/works/OL1200W\t\\N\tCurrently Reading\t2026-01-01\n',
  ];
  await fs.writeFile(worksPath, works.join(''));
  await fs.writeFile(ratingsPath, ratings.join(''));
  await fs.writeFile(readingLogPath, readingLog.join(''));
  const indexPath = join(directory, 'works-index');
  await buildOpenLibraryWorkIndex({
    worksPath,
    ratingsPath,
    readingLogPath,
    outputPath: indexPath,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
  });
  await mutateWorks(indexPath, [
    "UPDATE works SET title = '' WHERE key = '/works/OL1000W'",
    "UPDATE works SET title = '   ' WHERE key = '/works/OL1200W'",
    "UPDATE works SET key = '/works/OL1100' WHERE key = '/works/OL1100W'",
  ]);
  const excludePath = join(directory, 'exclude.txt');
  await fs.writeFile(excludePath, '\n/works/OL900W\n/works/OL900W\n\n/works/OL999999W\n');
  return { indexPath, excludePath };
}

function discoverOptions(indexPath, directory, extras = {}) {
  return {
    worksIndexPath: indexPath,
    snapshotId: SNAPSHOT_ID,
    limit: 10,
    outputPath: join(directory, 'discover.json'),
    minRatings: 1,
    minReaders: 1,
    generatedAt: GENERATED_AT,
    ...extras,
  };
}

test('discovery ranks by popularity, breaks ties by work key, and counts each filter once', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { indexPath, excludePath } = await buildRankingIndex(directory);
  assert.throws(() => globalThis.fetch('https://example.invalid'), /network access is forbidden/);

  const lookup = await createOpenLibraryWorkLookup({ indexPath, snapshotId: SNAPSHOT_ID });
  t.after(() => lookup.close());
  assert.equal(lookup.get('/works/OL100W').title, 'Highest');
  assert.equal(lookup.get('/works/OL1000W').title, '');
  assert.equal(lookup.get('/works/OL1200W').title, '   ');
  assert.equal(lookup.get('/works/OL1100W'), null);

  const limited = await discoverCatalogCandidates(discoverOptions(indexPath, directory, {
    excludeKeysPath: excludePath,
    limit: 2,
    outputPath: join(directory, 'top-two.json'),
  }));
  assert.deepEqual(limited.candidates.map(candidate => candidate.workKey), ['/works/OL100W', '/works/OL200W']);
  assert.equal(limited.counts.eligible, 5);
  assert.equal(limited.counts.selected, 2);
  assert.equal(limited.languageCheck, 'pending');
  assert.deepEqual(limited.counts.filteredByReason, {
    invalid_work_key: 1,
    missing_title: 2,
    missing_cover: 1,
    excluded: 1,
    no_signal: 1,
    below_min_ratings: 1,
    below_min_readers: 1,
  });

  const ranked = await discoverCatalogCandidates(discoverOptions(indexPath, directory, {
    excludeKeysPath: excludePath,
    outputPath: join(directory, 'ranked.json'),
  }));
  const expectedKeys = ['/works/OL100W', '/works/OL200W', '/works/OL300W', '/works/OL400W', '/works/OL450W'];
  assert.deepEqual(ranked.candidates.map(candidate => candidate.workKey), expectedKeys);
  assert.equal(ranked.counts.considered, 13);
  assert.equal(ranked.counts.eligible, 5);
  assert.equal(ranked.counts.selected, 5);
  assert.equal(ranked.candidates[1].score, ranked.candidates[2].score);
  assert.ok(ranked.candidates[0].score > ranked.candidates[1].score);
  assert.ok(ranked.candidates[2].score > ranked.candidates[3].score);
  assert.ok(ranked.candidates[3].score > ranked.candidates[4].score);
  const tied = popularityScore({
    ratingsCount: 4,
    ratingsSum: 16,
    readingLog: { 'Want to Read': 0, 'Currently Reading': 0, 'Already Read': 3 },
  });
  assert.equal(ranked.candidates[1].score, tied);
  assert.equal(ranked.candidates[2].score, tied);
  assert.equal(ranked.candidates[0].score, popularityScore({
    ratingsCount: 5,
    ratingsSum: 25,
    readingLog: { 'Want to Read': 0, 'Currently Reading': 0, 'Already Read': 40 },
  }));
  assert.deepEqual(ranked.candidates[0].authorKeys, ['/authors/OL9A']);
  assert.deepEqual(ranked.candidates[0].coverIds, [11]);
  assert.equal(ranked.candidates[0].title, 'Highest');
  assert.deepEqual(ranked.candidates[0].signals, {
    ratingsCount: 5,
    ratingsSum: 25,
    readingLog: { 'Want to Read': 0, 'Currently Reading': 0, 'Already Read': 40 },
  });
  assert.deepEqual(ranked.candidates[4].signals.readingLog, {
    'Want to Read': 1,
    'Currently Reading': 0,
    'Already Read': 0,
  });
  assert.equal(ranked.scoring.minRatings, 1);
  assert.equal(ranked.scoring.minReaders, 1);
  assert.equal(ranked.scoring.priorRatings, 20);
  assert.equal(ranked.scoring.alreadyReadWeight, 1);
  assert.equal(ranked.scoring.currentlyReadingWeight, 0.75);
  assert.equal(ranked.scoring.wantToReadWeight, 0.25);
  assert.equal(CATALOG_DISCOVER_SCORING.minReaders, 10);
  assert.equal(CATALOG_DISCOVER_SCORING.minRatings, 0);
  for (const key of ['/works/OL500W', '/works/OL600W', '/works/OL700W', '/works/OL800W', '/works/OL900W', '/works/OL1000W']) {
    assert.equal(ranked.candidates.some(candidate => candidate.workKey === key), false);
  }

  const again = await discoverCatalogCandidates(discoverOptions(indexPath, directory, {
    excludeKeysPath: excludePath,
    outputPath: join(directory, 'ranked-again.json'),
  }));
  assert.equal(await fs.readFile(ranked.outputPath, 'utf8'), await fs.readFile(again.outputPath, 'utf8'));
  const artifact = JSON.parse(await fs.readFile(ranked.outputPath, 'utf8'));
  assert.equal(artifact.format, 'bookish-catalog-discover');
  assert.equal(artifact.version, 1);
  assert.equal(artifact.languageCheck, 'pending');
  assert.equal(artifact.generatedAt, GENERATED_AT);
  assert.deepEqual(artifact.candidates, ranked.candidates);
});

test('a 4.5-star work outranks a huge want-to-read pile, and a no-signal work is filtered', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const worksPath = join(directory, 'works.txt');
  const ratingsPath = join(directory, 'ratings.txt');
  const readingLogPath = join(directory, 'reading-log.txt');
  await fs.writeFile(worksPath, [
    workLine('/works/OL1W', { title: 'Well Rated', covers: [1] }),
    workLine('/works/OL2W', { title: 'Want Pile', covers: [2] }),
    workLine('/works/OL3W', { title: 'No Signal', covers: [3] }),
  ].join(''));
  const ratings = await fs.open(ratingsPath, 'w');
  const shelves = await fs.open(readingLogPath, 'w');
  try {
    await writeCopies(ratings, '/works/OL1W\t\\N\t5\t2026-01-01\n', 1000);
    await writeCopies(ratings, '/works/OL1W\t\\N\t4\t2026-01-01\n', 1000);
    await writeCopies(ratings, '/works/OL2W\t\\N\t3\t2026-01-01\n', 150);
    await writeCopies(ratings, '/works/OL2W\t\\N\t2\t2026-01-01\n', 150);
    await writeCopies(shelves, '/works/OL1W\t\\N\tAlready Read\t2026-01-01\n', 50);
    await writeCopies(shelves, '/works/OL2W\t\\N\tWant to Read\t2026-01-01\n', 100_000);
  } finally {
    await ratings.close();
    await shelves.close();
  }
  const indexPath = join(directory, 'works-index');
  await buildOpenLibraryWorkIndex({
    worksPath,
    ratingsPath,
    readingLogPath,
    outputPath: indexPath,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
    batchSize: 5000,
  });
  const wellRated = {
    ratingsCount: 2000,
    ratingsSum: 9000,
    readingLog: readingLog({ 'Already Read': 50 }),
  };
  const wantPile = {
    ratingsCount: 300,
    ratingsSum: 750,
    readingLog: readingLog({ 'Want to Read': 100_000 }),
  };
  assert.equal(popularityScore({ ratingsCount: 0, ratingsSum: 0, readingLog: readingLog() }), 0);
  assert.ok(popularityScore(wellRated) > popularityScore(wantPile));
  const result = await discoverCatalogCandidates({
    worksIndexPath: indexPath,
    snapshotId: SNAPSHOT_ID,
    limit: 10,
    outputPath: join(directory, 'discover.json'),
    generatedAt: GENERATED_AT,
  });
  assert.deepEqual(result.candidates.map(candidate => candidate.title), ['Well Rated', 'Want Pile']);
  assert.equal(result.candidates[0].signals.ratingsCount, 2000);
  assert.equal(result.candidates[0].signals.ratingsSum, 9000);
  assert.equal(result.candidates[0].signals.readingLog['Already Read'], 50);
  assert.equal(result.candidates[1].signals.ratingsCount, 300);
  assert.equal(result.candidates[1].signals.readingLog['Want to Read'], 100_000);
  assert.equal(result.candidates[0].score, popularityScore(wellRated));
  assert.equal(result.candidates[1].score, popularityScore(wantPile));
  assert.equal(result.counts.filteredByReason.no_signal, 1);
  assert.equal(result.counts.eligible, 2);
  assert.equal(result.scoring.minRatings, 0);
  assert.equal(result.scoring.minReaders, 10);
});

test('a snapshot mismatch or invalid exclude file keeps the previous artifact', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { indexPath, excludePath } = await buildRankingIndex(directory);
  const outputPath = join(directory, 'discover.json');
  await discoverCatalogCandidates(discoverOptions(indexPath, directory, { excludeKeysPath: excludePath, outputPath }));
  const before = await fs.readFile(outputPath, 'utf8');

  await assert.rejects(
    discoverCatalogCandidates(discoverOptions(indexPath, directory, {
      excludeKeysPath: excludePath,
      outputPath,
      snapshotId: 'other-snapshot',
    })),
    error => error.code === 'work_snapshot_mismatch',
  );
  const missingExclude = join(directory, 'missing-exclude.txt');
  await assert.rejects(
    discoverCatalogCandidates(discoverOptions(indexPath, directory, { excludeKeysPath: missingExclude, outputPath })),
    error => error.code === 'invalid_argument' && error.message.includes('Unable to read exclude keys'),
  );
  const badExclude = join(directory, 'bad-exclude.txt');
  await fs.writeFile(badExclude, '/works/OL900W\n/works/NOPE\n');
  await assert.rejects(
    discoverCatalogCandidates(discoverOptions(indexPath, directory, { excludeKeysPath: badExclude, outputPath })),
    error => error.code === 'invalid_argument' && /Exclude key at .+:2 must match/.test(error.message),
  );
  await assert.rejects(
    discoverCatalogCandidates(discoverOptions(indexPath, directory, { outputPath, limit: 0 })),
    error => error.code === 'invalid_argument',
  );
  await assert.rejects(
    discoverCatalogCandidates(discoverOptions(indexPath, directory, { outputPath, limit: 10001 })),
    error => error.code === 'invalid_argument' && error.message.includes('limit must be at most 10000'),
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), before);
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp')), false);
  const preserved = JSON.parse(before);
  assert.equal(preserved.candidates[0].workKey, '/works/OL100W');
});

test('several thousand indexed works return the deterministic top limit', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const total = 3000;
  const worksPath = join(directory, 'works.txt');
  const ratingsPath = join(directory, 'ratings.txt');
  const readingLogPath = join(directory, 'reading-log.txt');
  const works = await fs.open(worksPath, 'w');
  const ratings = await fs.open(ratingsPath, 'w');
  const readingLog = await fs.open(readingLogPath, 'w');
  try {
    let worksBuffer = '';
    let ratingsBuffer = '';
    let readingBuffer = '';
    for (let index = 0; index < total; index += 1) {
      const key = `/works/OL${index}W`;
      const payload = JSON.stringify({ title: `Synthetic ${index}`, covers: [index + 1] });
      worksBuffer += `/type/work\t${key}\t1\t2026-01-01T00:00:00.000000\t${payload}\n`;
      ratingsBuffer += `${key}\t\\N\t${(index % 5) + 1}\t2026-01-01\n`;
      readingBuffer += `${key}\t\\N\tAlready Read\t2026-01-01\n`;
      if (worksBuffer.length >= 1024 * 1024) {
        await works.writeFile(worksBuffer);
        await ratings.writeFile(ratingsBuffer);
        await readingLog.writeFile(readingBuffer);
        worksBuffer = '';
        ratingsBuffer = '';
        readingBuffer = '';
      }
    }
    if (worksBuffer) {
      await works.writeFile(worksBuffer);
      await ratings.writeFile(ratingsBuffer);
      await readingLog.writeFile(readingBuffer);
    }
  } finally {
    await works.close();
    await ratings.close();
    await readingLog.close();
  }

  const indexPath = join(directory, 'works-index');
  await buildOpenLibraryWorkIndex({
    worksPath,
    ratingsPath,
    readingLogPath,
    outputPath: indexPath,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
    batchSize: 500,
  });
  const limit = 10;
  const result = await discoverCatalogCandidates({
    worksIndexPath: indexPath,
    snapshotId: SNAPSHOT_ID,
    limit,
    minReaders: 0,
    outputPath: join(directory, 'discover.json'),
    generatedAt: GENERATED_AT,
  });
  const oneAlreadyRead = { 'Want to Read': 0, 'Currently Reading': 0, 'Already Read': 1 };
  const expected = [];
  for (let index = 0; index < total; index += 1) {
    expected.push({
      workKey: `/works/OL${index}W`,
      score: popularityScore({ ratingsCount: 1, ratingsSum: (index % 5) + 1, readingLog: oneAlreadyRead }),
    });
  }
  expected.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.workKey < right.workKey) return -1;
    if (left.workKey > right.workKey) return 1;
    return 0;
  });
  assert.equal(result.counts.considered, total);
  assert.equal(result.counts.eligible, total);
  assert.equal(result.counts.selected, limit);
  assert.equal(result.candidates.length, limit);
  assert.deepEqual(result.candidates.map(candidate => candidate.workKey), expected.slice(0, limit).map(candidate => candidate.workKey));
  assert.equal(result.candidates.some(candidate => candidate.workKey === expected[limit].workKey), false);
  for (const reason of Object.values(result.counts.filteredByReason)) assert.equal(reason, 0);
});

test('discover CLI validates arguments and leaves the previous artifact on failure', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { indexPath, excludePath } = await buildRankingIndex(directory);
  const script = fileURLToPath(new URL('../scripts/catalog-discover.js', import.meta.url));
  const outputPath = join(directory, 'cli-discover.json');
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['catalog:discover'], 'node --experimental-sqlite scripts/catalog-discover.js');

  const success = await execFileAsync(process.execPath, [
    '--experimental-sqlite',
    script,
    '--works-index', indexPath,
    '--snapshot-id', SNAPSHOT_ID,
    '--limit', '2',
    '--min-ratings', '1',
    '--min-readers', '1',
    '--exclude-keys', excludePath,
    '--output', outputPath,
  ]);
  const summary = JSON.parse(success.stdout);
  assert.equal(summary.outputPath, outputPath);
  assert.equal(summary.counts.selected, 2);
  assert.equal(summary.counts.filteredByReason.excluded, 1);
  assert.equal(summary.languageCheck, 'pending');
  assert.equal(Object.hasOwn(summary, 'candidates'), false);
  const artifact = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  assert.deepEqual(artifact.candidates.map(candidate => candidate.workKey), ['/works/OL100W', '/works/OL200W']);
  const before = await fs.readFile(outputPath, 'utf8');

  await assert.rejects(
    execFileAsync(process.execPath, ['--experimental-sqlite', script, '--limit', '2']),
    error => error.code === 1 && error.stderr.includes('--works-index, --snapshot-id, and --limit are required'),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--experimental-sqlite', script,
      '--works-index', indexPath,
      '--snapshot-id', SNAPSHOT_ID,
      '--limit', '2',
      '--not-a-flag',
    ]),
    error => error.code === 1 && error.stderr.includes('Unknown argument --not-a-flag'),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--experimental-sqlite', script,
      '--works-index', indexPath,
      '--snapshot-id', SNAPSHOT_ID,
      '--limit',
    ]),
    error => error.code === 1 && error.stderr.includes('--limit requires a value'),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--experimental-sqlite', script,
      '--works-index', indexPath,
      '--snapshot-id', SNAPSHOT_ID,
      '--limit', '0',
    ]),
    error => error.code === 1 && error.stderr.includes('--limit must be a positive integer'),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--experimental-sqlite', script,
      '--works-index', indexPath,
      '--snapshot-id', SNAPSHOT_ID,
      '--limit', '10001',
    ]),
    error => error.code === 1 && error.stderr.includes('--limit must be at most 10000'),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--experimental-sqlite', script,
      '--works-index', indexPath,
      '--snapshot-id', SNAPSHOT_ID,
      '--limit', '2',
      '--min-ratings', '-1',
    ]),
    error => error.code === 1 && error.stderr.includes('--min-ratings must be a non-negative integer'),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--experimental-sqlite', script,
      '--works-index', indexPath,
      '--snapshot-id', 'other-snapshot',
      '--limit', '2',
      '--output', outputPath,
    ]),
    error => error.code === 1 && error.stderr.includes('Work index snapshotId does not match the requested snapshot'),
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), before);
});

test('writeDiscoverArtifactAtomically leaves the previous artifact unchanged when validation fails', async () => {
  const directory = await temporaryDirectory();
  const outputPath = join(directory, 'discover.json');
  const settings = { snapshotId: SNAPSHOT_ID, limit: 1 };
  const good = {
    format: CATALOG_DISCOVER_FORMAT,
    version: CATALOG_DISCOVER_VERSION,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
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
      considered: 1,
      filteredByReason: {
        invalid_work_key: 0,
        missing_title: 0,
        missing_cover: 0,
        excluded: 0,
        no_signal: 0,
        below_min_ratings: 0,
        below_min_readers: 0,
      },
      eligible: 1,
      selected: 1,
    },
    candidates: [{
      workKey: '/works/OL100W',
      title: 'Fixture',
      authorKeys: ['/authors/OL1A'],
      coverIds: [1],
      score: popularityScore({
        ratingsCount: 5,
        ratingsSum: 20,
        readingLog: { 'Want to Read': 1, 'Currently Reading': 1, 'Already Read': 10 },
      }),
      signals: {
        ratingsCount: 5,
        ratingsSum: 20,
        readingLog: { 'Want to Read': 1, 'Currently Reading': 1, 'Already Read': 10 },
      },
    }],
  };
  await writeDiscoverArtifactAtomically(outputPath, good, settings);
  const before = await fs.readFile(outputPath, 'utf8');
  const bad = { ...good, version: 999 };

  await assert.rejects(
    () => writeDiscoverArtifactAtomically(outputPath, bad, settings),
    error => error?.code === 'invalid_discover_artifact',
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), before);
});

test('discover source does not reference Prisma, the database URL, or fetch', async () => {
  const moduleSource = await fs.readFile(new URL('../scripts/catalog/discover.js', import.meta.url), 'utf8');
  const cliSource = await fs.readFile(new URL('../scripts/catalog-discover.js', import.meta.url), 'utf8');
  for (const source of [moduleSource, cliSource]) {
    assert.equal(source.includes('prisma'), false);
    assert.equal(source.includes('DATABASE_URL'), false);
    assert.equal(source.includes('fetch('), false);
  }
});
