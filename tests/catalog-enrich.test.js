import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildOpenLibraryAuthorIndex, buildOpenLibraryAuthorLookup, createOpenLibraryAuthorLookup, readOpenLibraryBulkRecords } from '../scripts/catalog/open-library-bulk.js';
import { bridgeCatalogWorks } from '../scripts/catalog/bridge.js';
import { sealLanguageCheckedArtifact } from './catalog/language-check-helpers.js';
import {
  CATALOG_DISCOVER_FORMAT,
  CATALOG_DISCOVER_SCORING,
  CATALOG_DISCOVER_VERSION,
  popularityScore,
} from '../scripts/catalog/discover.js';
import {
  CATALOG_ENRICH_MAX_ISBNS,
  enrichCatalogCandidates,
  validateEnrichedArtifact,
  writeEnrichedArtifactAtomically,
} from '../scripts/catalog/enrich.js';
import {
  createReadOnlyDbInterface,
  loadDiscoverCandidates,
  runCatalogDedupCheck,
} from '../scripts/catalog/dedup-check.js';

const execFileAsync = promisify(execFile);
const SNAPSHOT_ID = 'fixture-snapshot';
const GENERATED_AT = '2026-08-31T00:00:00.000Z';
const SCRIPT = fileURLToPath(new URL('../scripts/catalog-enrich.js', import.meta.url));

function isbn13For(index) {
  const stem = `978${String(index).padStart(9, '0')}`;
  const sum = [...stem].reduce((total, digit, position) => total + Number(digit) * (position % 2 ? 3 : 1), 0);
  return `${stem}${(10 - sum % 10) % 10}`;
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

function discoverArtifact(candidates, snapshotId = SNAPSHOT_ID) {
  return {
    format: CATALOG_DISCOVER_FORMAT,
    version: CATALOG_DISCOVER_VERSION,
    snapshotId,
    generatedAt: GENERATED_AT,
    languageCheck: 'pending',
    scoring: { ...CATALOG_DISCOVER_SCORING },
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

function editionLine(key, data) {
  return `/type/edition\t${key}\t1\t2026-01-01T00:00:00.000000\t${JSON.stringify(data)}\n`;
}

function authorLine(key, name) {
  return `/type/author\t${key}\t1\t2026-01-01T00:00:00.000000\t${JSON.stringify({ name })}\n`;
}

async function temporaryDirectory() {
  return fs.mkdtemp(join(tmpdir(), 'bookish-catalog-enrich-'));
}

async function writeGzip(path, text) {
  await fs.writeFile(path, gzipSync(Buffer.from(text)));
}

async function writeAuthorIndex(directory, authors, snapshotId = SNAPSHOT_ID, { lookup = true } = {}) {
  const inputPath = join(directory, `authors-${snapshotId}.txt`);
  const indexPath = join(directory, `author-index-${snapshotId}`);
  await fs.writeFile(inputPath, authors.map(author => authorLine(author.key, author.name)).join(''));
  await buildOpenLibraryAuthorIndex({
    inputPath,
    outputPath: indexPath,
    snapshotId,
    generatedAt: GENERATED_AT,
  });
  if (lookup) await buildOpenLibraryAuthorLookup({ indexPath, snapshotId, batchSize: 1 });
  return indexPath;
}

function assertNoTempFiles(names) {
  assert.deepEqual(names.filter(name => name.includes('.tmp') || name.includes('.bak')), []);
}

async function enrichFixture({
  directory,
  candidates,
  editions,
  authors,
  authorsIndexPath: existingAuthorIndex = null,
  snapshotId = SNAPSHOT_ID,
  authorSnapshotId = snapshotId,
  progressInterval = 1,
  outputName = 'enriched.json',
  editionsName = 'ol_dump_editions_fixture.txt.gz',
}) {
  const inputPath = join(directory, `discover-${outputName}`);
  const editionsPath = join(directory, editionsName);
  const outputPath = join(directory, outputName);
  await fs.writeFile(inputPath, `${JSON.stringify(discoverArtifact(candidates, snapshotId))}\n`);
  await writeGzip(editionsPath, editions);
  const authorsIndexPath = existingAuthorIndex ?? await writeAuthorIndex(directory, authors, authorSnapshotId);
  const progress = [];
  const result = await enrichCatalogCandidates({
    inputPath,
    editionsPath,
    authorsIndexPath,
    outputPath,
    progressInterval,
    onProgress: counts => progress.push(counts),
  });
  return { ...result, inputPath, editionsPath, authorsIndexPath, outputPath, progress };
}

test('enrich converts ISBN-10 including X, drops invalid checksums, and dedupes', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const editions = [
    editionLine('/books/OL1M', {
      title: 'Pride and Prejudice',
      works: [{ key: '/works/OL100W' }, { key: '/works/OL100W' }, { key: '/works/OL999W' }],
      isbn_13: ['978-0-14-143951-8', '9780141439519', 'not-an-isbn'],
      isbn_10: ['0141439513', '0141439514', '080442957X', '0-8044-2957-X'],
    }),
    editionLine('/books/OL2M', {
      title: 'Another printing',
      works: [{ key: '/works/OL100W' }],
      isbn_13: ['9780141439518'],
      isbn_10: ['0804429570'],
    }),
    editionLine('/books/OL3M', {
      title: 'Unrelated',
      works: [{ key: '/works/OL404W' }],
      isbn_13: [isbn13For(50)],
    }),
    '/type/work\t/works/OL100W\t1\t2026-01-01T00:00:00.000000\t{"title":"Ignored work"}\n',
    '/type/edition\t/books/OLBROKENM\t1\t2026-01-01T00:00:00.000000\t{not-json}\n',
  ].join('');
  const result = await enrichFixture({
    directory,
    candidates: [discoverCandidate({ workKey: '/works/OL100W', title: 'Pride and Prejudice' })],
    editions,
    authors: [{ key: '/authors/OL1A', name: 'Jane Austen' }],
  });

  assert.deepEqual(result.artifact.candidates[0].isbns, ['9780141439518', '9780804429573']);
  assert.equal(result.artifact.candidates[0].primaryAuthor, 'Jane Austen');
  assert.equal(result.artifact.snapshotId, SNAPSHOT_ID);
  assert.equal(result.matchedEditions, 2);
  assert.equal(result.worksWithIsbns, 1);
  assert.equal(result.worksWithoutIsbns, 0);
  assert.equal(result.worksWithAuthor, 1);
  assert.equal(result.badChecksums, 4);
  assert.equal(result.malformedRows, 1);
  assert.equal(result.worksIsbnTruncated, 0);
  assert.equal((await fs.stat(join(result.authorsIndexPath, 'lookup.sqlite'))).isFile(), true);
  assert.ok(result.progress.length >= 1);
  assert.equal(result.progress.at(-1).matchedEditions, 2);
  assert.equal(result.progress.at(-1).worksWithIsbns, 1);
  const written = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
  validateEnrichedArtifact(written, { snapshotId: SNAPSHOT_ID });
  const loaded = await loadDiscoverCandidates(result.outputPath);
  assert.deepEqual(loaded[0].isbns, ['9780141439518', '9780804429573']);
  assert.equal(loaded[0].primaryAuthor, 'Jane Austen');
});

test('enrich keeps the lowest 200 ISBN-13s per work', async (t) => {
  assert.equal(CATALOG_ENRICH_MAX_ISBNS, 200);
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const isbns = Array.from({ length: 201 }, (_, index) => isbn13For(index + 1000)).reverse();
  const result = await enrichFixture({
    directory,
    candidates: [discoverCandidate()],
    editions: editionLine('/books/OLCAPM', {
      title: 'Many ISBNs',
      works: [{ key: '/works/OL100W' }],
      isbn_13: isbns,
    }),
    authors: [{ key: '/authors/OL1A', name: 'Jane Austen' }],
  });
  const expected = Array.from({ length: 200 }, (_, index) => isbn13For(index + 1000));
  assert.deepEqual(result.artifact.candidates[0].isbns, expected);
  assert.equal(result.worksIsbnTruncated, 1);
});

test('enrich keeps the same ISBN-13 set for a 60+ edition work regardless of dump order', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const total = 220;
  const lines = Array.from({ length: total }, (_, index) => editionLine(`/books/OL${index}M`, {
    title: 'Many Editions',
    works: [{ key: '/works/OL100W' }],
    isbn_13: [isbn13For(index)],
  }));
  const authors = [{ key: '/authors/OL1A', name: 'Jane Austen' }];
  const authorsIndexPath = await writeAuthorIndex(directory, authors);
  const candidates = [discoverCandidate()];
  const forward = await enrichFixture({
    directory,
    candidates,
    editions: lines.join(''),
    authorsIndexPath,
    outputName: 'forward.json',
    editionsName: 'forward.txt.gz',
  });
  const reverse = await enrichFixture({
    directory,
    candidates,
    editions: lines.slice().reverse().join(''),
    authorsIndexPath,
    outputName: 'reverse.json',
    editionsName: 'reverse.txt.gz',
  });
  const expected = Array.from({ length: CATALOG_ENRICH_MAX_ISBNS }, (_, index) => isbn13For(index));
  assert.equal(total > 60, true);
  assert.deepEqual(forward.artifact.candidates[0].isbns, expected);
  assert.deepEqual(reverse.artifact.candidates[0].isbns, expected);
  assert.equal(forward.worksIsbnTruncated, 1);
  assert.equal(reverse.worksIsbnTruncated, 1);
  assert.equal(forward.matchedEditions, total);
  assert.equal(reverse.matchedEditions, total);
});

test('enrich leaves primaryAuthor null when the first author key is unknown', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const result = await enrichFixture({
    directory,
    candidates: [
      discoverCandidate({
        workKey: '/works/OL100W',
        authorKeys: ['/authors/OLMISSINGA', '/authors/OL1A'],
      }),
      discoverCandidate({
        workKey: '/works/OL200W',
        title: 'Known Author',
        authorKeys: ['/authors/OL1A'],
      }),
      discoverCandidate({
        workKey: '/works/OL300W',
        title: 'No Author Keys',
        authorKeys: [],
      }),
    ],
    editions: editionLine('/books/OL1M', {
      title: 'Edition',
      works: [{ key: '/works/OL100W' }],
      isbn_13: [isbn13For(7)],
    }),
    authors: [{ key: '/authors/OL1A', name: '  Jane   Austen  ' }],
  });
  const [unknown, known, empty] = result.artifact.candidates;
  assert.equal(unknown.primaryAuthor, null);
  assert.deepEqual(unknown.isbns, [isbn13For(7)]);
  assert.equal(known.primaryAuthor, 'Jane Austen');
  assert.deepEqual(known.isbns, []);
  assert.equal(empty.primaryAuthor, null);
  assert.equal(result.worksWithAuthor, 1);
  assert.equal(result.worksWithIsbns, 1);
  assert.equal(result.worksWithoutIsbns, 2);
  assert.equal(result.matchedEditions, 1);
});

test('enrich rejects an author index snapshot that differs from the input', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'enriched.json');
  const previous = '{"keep":"previous"}\n';
  await fs.writeFile(outputPath, previous);
  const inputPath = join(directory, 'discover.json');
  const editionsPath = join(directory, 'ol_dump_editions_fixture.txt.gz');
  await fs.writeFile(inputPath, `${JSON.stringify(discoverArtifact([discoverCandidate()]))}\n`);
  await writeGzip(editionsPath, editionLine('/books/OL1M', {
    title: 'Edition',
    works: [{ key: '/works/OL100W' }],
    isbn_13: [isbn13For(1)],
  }));
  const authorsIndexPath = await writeAuthorIndex(
    directory,
    [{ key: '/authors/OL1A', name: 'Jane Austen' }],
    'other-snapshot',
  );

  await assert.rejects(
    () => enrichCatalogCandidates({
      inputPath,
      editionsPath,
      authorsIndexPath,
      outputPath,
    }),
    error => error.code === 'author_snapshot_mismatch',
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), previous);
  assertNoTempFiles(await fs.readdir(directory));
});

test('enrich rejects a directory passed as the discover input and leaves no output', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, 'discover-dir');
  const editionsPath = join(directory, 'editions.txt');
  const outputPath = join(directory, 'enriched.json');
  const previous = '{"keep":"previous"}\n';
  await fs.mkdir(inputPath);
  await fs.writeFile(editionsPath, 'unused\n');
  await fs.writeFile(outputPath, previous);

  await assert.rejects(
    () => enrichCatalogCandidates({
      inputPath,
      editionsPath,
      authorsIndexPath: directory,
      outputPath,
    }),
    error => error.code === 'invalid_argument' && error.message.includes('discover input must be a file'),
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), previous);
  assertNoTempFiles(await fs.readdir(directory));
});

test('enrich rejects an unreadable editions file and leaves no output', { skip: process.getuid?.() === 0 }, async (t) => {
  const directory = await temporaryDirectory();
  t.after(async () => {
    await fs.chmod(join(directory, 'editions.txt'), 0o644).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  const inputPath = join(directory, 'discover.json');
  const editionsPath = join(directory, 'editions.txt');
  const outputPath = join(directory, 'enriched.json');
  const previous = '{"keep":"previous"}\n';
  await fs.writeFile(inputPath, `${JSON.stringify(discoverArtifact([discoverCandidate()]))}\n`);
  await fs.writeFile(editionsPath, 'secret\n');
  await fs.writeFile(outputPath, previous);
  const authorsIndexPath = await writeAuthorIndex(directory, [{ key: '/authors/OL1A', name: 'Jane Austen' }]);
  await fs.chmod(editionsPath, 0o000);

  await assert.rejects(
    () => enrichCatalogCandidates({
      inputPath,
      editionsPath,
      authorsIndexPath,
      outputPath,
    }),
    error => error.code === 'invalid_argument' && /Unable to read editions dump/.test(error.message) && /EACCES/.test(error.message),
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), previous);
  assertNoTempFiles(await fs.readdir(directory));
});

test('enrich requires lookup.sqlite instead of reading author shards', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'enriched.json');
  const previous = '{"keep":"previous"}\n';
  await fs.writeFile(outputPath, previous);
  const inputPath = join(directory, 'discover.json');
  const editionsPath = join(directory, 'editions.txt.gz');
  await fs.writeFile(inputPath, `${JSON.stringify(discoverArtifact([discoverCandidate()]))}\n`);
  await writeGzip(editionsPath, editionLine('/books/OL1M', {
    title: 'Edition',
    works: [{ key: '/works/OL100W' }],
    isbn_13: [isbn13For(2)],
  }));
  const authorsIndexPath = await writeAuthorIndex(
    directory,
    [{ key: '/authors/OL1A', name: 'Jane Austen' }],
    SNAPSHOT_ID,
    { lookup: false },
  );

  await assert.rejects(
    () => enrichCatalogCandidates({
      inputPath,
      editionsPath,
      authorsIndexPath,
      outputPath,
    }),
    error => error.code === 'invalid_author_index'
      && error.message.includes(`npm run catalog:ol-author-lookup-build -- --index "${authorsIndexPath}" --snapshot-id ${SNAPSHOT_ID}`),
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), previous);
  assertNoTempFiles(await fs.readdir(directory));
  assert.equal(await fs.access(join(authorsIndexPath, 'lookup.sqlite')).then(() => true).catch(() => false), false);
});

test('writeEnrichedArtifactAtomically keeps the previous file when validation fails', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'enriched.json');
  const candidate = {
    ...discoverCandidate(),
    isbns: [isbn13For(4)],
    primaryAuthor: 'Jane Austen',
  };
  const good = discoverArtifact([candidate]);
  good.candidates = [candidate];
  await writeEnrichedArtifactAtomically(outputPath, good, { snapshotId: SNAPSHOT_ID });
  const before = await fs.readFile(outputPath, 'utf8');
  const bad = { ...good, snapshotId: 'other-snapshot' };

  await assert.rejects(
    () => writeEnrichedArtifactAtomically(outputPath, bad, { snapshotId: SNAPSHOT_ID }),
    error => error.code === 'invalid_enriched_artifact',
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), before);
  const leftovers = (await fs.readdir(directory)).filter(name => name.includes('.tmp') || name.includes('.bak'));
  assert.deepEqual(leftovers, []);
});

test('enrich then dedup-check matches by ISBN and by title plus author', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const prideIsbn = '9780141439518';
  const result = await enrichFixture({
    directory,
    candidates: [
      discoverCandidate({
        workKey: '/works/OL100W',
        title: 'Pride and Prejudice',
        authorKeys: ['/authors/OL1A'],
      }),
      discoverCandidate({
        workKey: '/works/OL200W',
        title: 'Dune',
        authorKeys: ['/authors/OL2A'],
      }),
    ],
    editions: [
      editionLine('/books/OLPRIDEM', {
        title: 'Pride and Prejudice',
        works: [{ key: '/works/OL100W' }],
        isbn_10: ['0141439513'],
      }),
      editionLine('/books/OLUNRELATEDM', {
        title: 'Other',
        works: [{ key: '/works/OL404W' }],
        isbn_13: [isbn13For(9)],
      }),
    ].join(''),
    authors: [
      { key: '/authors/OL1A', name: 'Jane Austen' },
      { key: '/authors/OL2A', name: 'Frank Herbert' },
    ],
  });
  assert.deepEqual(result.artifact.candidates[0].isbns, [prideIsbn]);
  assert.equal(result.artifact.candidates[0].primaryAuthor, 'Jane Austen');
  assert.deepEqual(result.artifact.candidates[1].isbns, []);
  assert.equal(result.artifact.candidates[1].primaryAuthor, 'Frank Herbert');
  assert.equal(result.worksWithIsbns, 1);
  assert.equal(result.worksWithoutIsbns, 1);
  assert.equal(result.worksWithAuthor, 2);

  const calls = [];
  const client = {
    book: {
      findMany: async () => {
        calls.push('findMany');
        return [
          {
            id: 'book-isbn',
            title: 'A Different Pride Title',
            author: 'Someone Else',
            isbn: prideIsbn,
            openLibraryWorkKey: null,
          },
          {
            id: 'book-title',
            title: 'Dune',
            author: 'Herbert, Frank',
            isbn: null,
            openLibraryWorkKey: null,
          },
        ];
      },
      create: async () => { calls.push('create'); throw new Error('create'); },
      update: async () => { calls.push('update'); throw new Error('update'); },
      delete: async () => { calls.push('delete'); throw new Error('delete'); },
    },
    $disconnect: async () => { calls.push('$disconnect'); },
    $executeRaw: async () => { calls.push('$executeRaw'); throw new Error('execute'); },
    $queryRaw: async () => { calls.push('$queryRaw'); throw new Error('query'); },
  };
  const readOnly = createReadOnlyDbInterface(client);
  assert.equal(readOnly.book.create, undefined);
  assert.equal(readOnly.$queryRaw, undefined);
  const reportPath = join(directory, 'dedup.jsonl');
  const { summary, results } = await runCatalogDedupCheck({
    db: readOnly,
    inputPath: result.outputPath,
    outputPath: reportPath,
  });
  assert.deepEqual(summary, { new: 0, existing: 2, ambiguous: 0 });
  assert.equal(results[0].matchedBy, 'isbn');
  assert.deepEqual(results[0].matchedBookIds, ['book-isbn']);
  assert.equal(results[1].matchedBy, 'titleAuthor');
  assert.deepEqual(results[1].matchedBookIds, ['book-title']);
  assert.deepEqual(calls, ['findMany']);
});

test('catalog:enrich CLI writes the enriched artifact and prints counts', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, 'discover.json');
  const editionsPath = join(directory, 'ol_dump_editions_fixture.txt.gz');
  const outputPath = join(directory, 'enriched.json');
  await fs.writeFile(inputPath, `${JSON.stringify(discoverArtifact([
    discoverCandidate({ workKey: '/works/OL100W', title: 'Pride and Prejudice' }),
  ]))}\n`);
  await writeGzip(editionsPath, editionLine('/books/OL1M', {
    title: 'Pride and Prejudice',
    works: [{ key: '/works/OL100W' }],
    isbn_10: ['0-8044-2957-X'],
  }));
  const authorsIndexPath = await writeAuthorIndex(directory, [{ key: '/authors/OL1A', name: 'Jane Austen' }]);
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-sqlite',
    SCRIPT,
    '--input', inputPath,
    '--editions', editionsPath,
    '--authors-index', authorsIndexPath,
    '--output', outputPath,
    '--progress-interval', '1',
  ]);
  const summary = JSON.parse(stdout);
  assert.equal(summary.snapshotId, SNAPSHOT_ID);
  assert.equal(summary.matchedEditions, 1);
  assert.equal(summary.worksWithIsbns, 1);
  assert.equal(summary.worksWithoutIsbns, 0);
  assert.equal(summary.worksWithAuthor, 1);
  const written = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  assert.deepEqual(written.candidates[0].isbns, ['9780804429573']);
  assert.equal(written.candidates[0].primaryAuthor, 'Jane Austen');
  await loadDiscoverCandidates(outputPath);
});

test('catalog:enrich CLI rejects unknown arguments and a snapshot mismatch', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    () => execFileAsync(process.execPath, ['--experimental-sqlite', SCRIPT, '--not-a-flag']),
    error => error.code === 1 && error.stderr.includes('Unknown argument --not-a-flag'),
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, ['--experimental-sqlite', SCRIPT, '--input']),
    error => error.code === 1 && error.stderr.includes('--input requires a value'),
  );

  const inputPath = join(directory, 'discover.json');
  const editionsPath = join(directory, 'ol_dump_editions_fixture.txt.gz');
  const outputPath = join(directory, 'enriched.json');
  const previous = '{"keep":"previous"}\n';
  await fs.writeFile(outputPath, previous);
  await fs.writeFile(inputPath, `${JSON.stringify(discoverArtifact([discoverCandidate()]))}\n`);
  await writeGzip(editionsPath, editionLine('/books/OL1M', {
    title: 'Edition',
    works: [{ key: '/works/OL100W' }],
    isbn_13: [isbn13For(3)],
  }));
  const authorsIndexPath = await writeAuthorIndex(
    directory,
    [{ key: '/authors/OL1A', name: 'Jane Austen' }],
    'other-snapshot',
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      '--experimental-sqlite',
      SCRIPT,
      '--input', inputPath,
      '--editions', editionsPath,
      '--authors-index', authorsIndexPath,
      '--output', outputPath,
    ]),
    error => error.code === 1 && error.stderr.includes('Author index snapshotId does not match the discover artifact'),
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), previous);
});

test('enrich source does not reference Prisma, the database URL, or fetch', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['catalog:enrich'], 'node --experimental-sqlite scripts/catalog-enrich.js');
  const moduleSource = await fs.readFile(new URL('../scripts/catalog/enrich.js', import.meta.url), 'utf8');
  const cliSource = await fs.readFile(new URL('../scripts/catalog-enrich.js', import.meta.url), 'utf8');
  for (const source of [moduleSource, cliSource]) {
    assert.equal(source.includes('prisma'), false);
    assert.equal(source.includes('DATABASE_URL'), false);
    assert.equal(source.includes('fetch('), false);
  }
});

test('enrich prioritizes verified English ISBNs and fills remaining capacity with lowest other ISBNs', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const other = Array.from({ length: 210 }, (_, index) => editionLine(`/books/OL${index + 1000}M`, {
    works: [{ key: '/works/OL100W' }],
    languages: [{ key: '/languages/spa' }],
    isbn_13: [isbn13For(index + 1000)],
  }));
  const english = Array.from({ length: 3 }, (_, index) => editionLine(`/books/OL${index + 5000}M`, {
    works: [{ key: '/works/OL100W' }],
    languages: [{ key: '/languages/eng' }],
    isbn_13: [isbn13For(index + 5000)],
  }));
  const authors = [{ key: '/authors/OL1A', name: 'Jane Austen' }];
  const authorIndex = await writeAuthorIndex(directory, authors);
  const run = (lines, label) => enrichFixture({
    directory,
    candidates: [discoverCandidate()],
    editions: lines.join(''),
    authorsIndexPath: authorIndex,
    outputName: label + '.json',
    editionsName: label + '.txt.gz',
  });
  const forward = await run([...other, ...english], 'mixed-forward');
  const reverse = await run([...english, ...other].reverse(), 'mixed-reverse');
  const expected = [
    ...Array.from({ length: 197 }, (_, index) => isbn13For(index + 1000)),
    isbn13For(5000), isbn13For(5001), isbn13For(5002),
  ].sort();
  assert.deepEqual(forward.artifact.candidates[0].isbns, expected);
  assert.deepEqual(reverse.artifact.candidates[0].isbns, expected);
  assert.equal(forward.worksIsbnTruncated, 1);
  assert.equal(reverse.worksIsbnTruncated, 1);
});

test('enrich quality-ranks English ISBNs before applying the 200 cap', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ordinary = Array.from({ length: 200 }, (_, index) => editionLine(`/books/OL${index + 1000}M`, {
    works: [{ key: '/works/OL100W' }],
    languages: [{ key: '/languages/eng' }],
    isbn_13: [isbn13For(index + 1000)],
    title: 'Generic version',
  }));
  const highQuality = editionLine('/books/OLBESTM', {
    works: [{ key: '/works/OL100W' }],
    languages: [{ key: '/languages/eng' }],
    isbn_13: [isbn13For(9000)],
    title: 'Sample Work',
    authors: [{ key: '/authors/OL1A' }],
    publish_date: '2021',
    covers: [1234],
  });
  const forward = await enrichFixture({
    directory, candidates: [discoverCandidate({ title: 'Sample Work' })],
    editions: [...ordinary, highQuality].join(''),
    authors: [{ key: '/authors/OL1A', name: 'Jane Austen' }],
  });
  const chosen = forward.artifact.candidates[0].isbns;
  assert.equal(chosen.length, 200);
  assert.equal(chosen.includes(isbn13For(9000)), true);
  assert.equal(chosen.includes(isbn13For(1199)), false);
});

function englishEdition(key, isbnIndex, extra = {}) {
  return editionLine(key, {
    works: [{ key: '/works/OL100W' }],
    languages: [{ key: '/languages/eng' }],
    isbn_13: [isbn13For(isbnIndex)],
    ...extra,
  });
}

const ordinaryEnglish = () => Array.from({ length: 200 }, (_, index) => englishEdition(
  `/books/OL${index + 1000}M`,
  index + 1000,
  { title: 'Generic version' },
));
const AUSTEN = [{ key: '/authors/OL1A', name: 'Jane Austen' }];

test('enrich: English audiobooks and other disqualified editions cannot evict eligible English print editions', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const rich = { title: 'Sample Work', authors: [{ key: '/authors/OL1A' }], publish_date: '2021', covers: [1] };
  const disqualified = [
    englishEdition('/books/OLAUDIOM', 9000, { ...rich, physical_format: 'Audiobook' }),
    englishEdition('/books/OLTITLEAUDIOM', 9001, { ...rich, title: 'Sample Work (audiobook)' }),
    englishEdition('/books/OLSUBAUDIOM', 9002, { ...rich, subtitle: 'Spoken Word' }),
  ];
  const result = await enrichFixture({
    directory,
    candidates: [discoverCandidate({ title: 'Sample Work' })],
    editions: [...ordinaryEnglish(), ...disqualified].join(''),
    authors: AUSTEN,
  });
  const chosen = result.artifact.candidates[0].isbns;
  assert.deepEqual(chosen, Array.from({ length: 200 }, (_, index) => isbn13For(index + 1000)));
  for (const index of [9000, 9001, 9002]) assert.equal(chosen.includes(isbn13For(index)), false);
});

test('enrich: an English edition that is disqualified is still used when no eligible English edition exists', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const result = await enrichFixture({
    directory,
    candidates: [discoverCandidate()],
    editions: [
      englishEdition('/books/OLAUDIOM', 9000, { physical_format: 'Audiobook' }),
      editionLine('/books/OLSPAM', {
        works: [{ key: '/works/OL100W' }],
        languages: [{ key: '/languages/spa' }],
        isbn_13: [isbn13For(1)],
      }),
    ].join(''),
    authors: AUSTEN,
  });
  assert.deepEqual(result.artifact.candidates[0].isbns, [isbn13For(1), isbn13For(9000)].sort());
  assert.equal(result.worksIsbnTruncated, 0);
});

test('enrich: equivalent title punctuation and formatting normalizes consistently', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const variants = ['The Sample-Work!', '  sample   WORK  ', 'Sample: Work'];
  const editions = variants.map((title, index) => englishEdition(`/books/OLVARIANT${index}M`, 9000 + index, { title }));
  const result = await enrichFixture({
    directory,
    candidates: [discoverCandidate({ title: 'Sample Work' })],
    editions: [...ordinaryEnglish(), ...editions].join(''),
    authors: AUSTEN,
  });
  const chosen = result.artifact.candidates[0].isbns;
  assert.equal(chosen.length, 200);
  for (const index of [9000, 9001, 9002]) assert.equal(chosen.includes(isbn13For(index)), true);
  for (const index of [1197, 1198, 1199]) assert.equal(chosen.includes(isbn13For(index)), false);
});

test('enrich: other-language and unknown-language ISBN evidence is preserved when capacity remains', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lines = [
    englishEdition('/books/OLENG1M', 5000),
    englishEdition('/books/OLENG2M', 5001),
    editionLine('/books/OLSPAM', { works: [{ key: '/works/OL100W' }], languages: [{ key: '/languages/spa' }], isbn_13: [isbn13For(10)] }),
    editionLine('/books/OLUNKNOWNM', { works: [{ key: '/works/OL100W' }], isbn_13: [isbn13For(11)] }),
  ];
  const result = await enrichFixture({ directory, candidates: [discoverCandidate()], editions: lines.join(''), authors: AUSTEN });
  assert.deepEqual(
    result.artifact.candidates[0].isbns,
    [isbn13For(5000), isbn13For(5001), isbn13For(10), isbn13For(11)].sort(),
  );
  assert.equal(result.worksIsbnTruncated, 0);
});

test('enrich: reversing a full editions dump yields the same mixed English/other selection', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authorsIndexPath = await writeAuthorIndex(directory, AUSTEN);
  const lines = [
    ...Array.from({ length: 5 }, (_, index) => englishEdition(`/books/OLENG${index}M`, 5000 + index, { title: 'Sample Work' })),
    englishEdition('/books/OLAUDIOM', 1, { physical_format: 'Audiobook' }),
    ...Array.from({ length: 150 }, (_, index) => editionLine(`/books/OLSPA${index}M`, {
      works: [{ key: '/works/OL100W' }], languages: [{ key: '/languages/spa' }], isbn_13: [isbn13For(100 + index)],
    })),
    ...Array.from({ length: 100 }, (_, index) => editionLine(`/books/OLUNK${index}M`, {
      works: [{ key: '/works/OL100W' }], isbn_13: [isbn13For(300 + index)],
    })),
  ];
  const run = (ordered, label) => enrichFixture({
    directory,
    candidates: [discoverCandidate({ title: 'Sample Work' })],
    editions: ordered.join(''),
    authorsIndexPath,
    outputName: `${label}.json`,
    editionsName: `${label}.txt.gz`,
  });
  const forward = await run(lines, 'full-forward');
  const reverse = await run(lines.slice().reverse(), 'full-reverse');
  const chosen = forward.artifact.candidates[0].isbns;
  assert.deepEqual(reverse.artifact.candidates[0].isbns, chosen);
  assert.equal(chosen.length, 200);
  for (let index = 0; index < 5; index += 1) assert.equal(chosen.includes(isbn13For(5000 + index)), true);
  assert.equal(chosen.includes(isbn13For(1)), true);
  assert.equal(chosen.includes(isbn13For(100)), true);
  assert.equal(chosen.includes(isbn13For(100 + 149)), true);
  assert.equal(chosen.includes(isbn13For(300 + 99)), false);
  assert.equal(forward.worksIsbnTruncated, 1);
  assert.equal(reverse.worksIsbnTruncated, 1);
});

test('enrich: a duplicate ISBN keeps its best observed quality score regardless of record order', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authorsIndexPath = await writeAuthorIndex(directory, AUSTEN);
  const low = englishEdition('/books/OLLOWM', 9000, { title: 'Other title' });
  const high = englishEdition('/books/OLHIGHM', 9000, {
    title: 'Sample Work', authors: [{ key: '/authors/OL1A' }], covers: [1], publish_date: '2020',
  });
  const run = (ordered, label) => enrichFixture({
    directory,
    candidates: [discoverCandidate({ title: 'Sample Work' })],
    editions: ordered.join(''),
    authorsIndexPath,
    outputName: `${label}.json`,
    editionsName: `${label}.txt.gz`,
  });
  const lowFirst = await run([low, ...ordinaryEnglish(), high], 'dup-low-first');
  const highFirst = await run([high, ...ordinaryEnglish(), low], 'dup-high-first');
  for (const result of [lowFirst, highFirst]) {
    assert.equal(result.artifact.candidates[0].isbns.length, 200);
    assert.equal(result.artifact.candidates[0].isbns.includes(isbn13For(9000)), true);
  }
  assert.deepEqual(lowFirst.artifact.candidates[0].isbns, highFirst.artifact.candidates[0].isbns);
});

test('enrich: audio format variants (Audio, Audio book, Audio recording) do not displace eligible print editions', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authorsIndexPath = await writeAuthorIndex(directory, AUSTEN);
  const formats = ['Audio', 'Audio book', 'Audio recording'];
  const highScoringAudio = Array.from({ length: 200 }, (_, index) => editionLine(`/books/OLAUDIO${index}M`, {
    works: [{ key: '/works/OL100W' }],
    languages: [{ key: '/languages/eng' }],
    isbn_13: [isbn13For(2000 + index)],
    title: 'Sample Work',
    authors: [{ key: '/authors/OL1A' }],
    publish_date: '2021',
    covers: [100 + index],
    physical_format: formats[index % formats.length],
  }));
  const printEdition = editionLine('/books/OLPRINTM', {
    works: [{ key: '/works/OL100W' }],
    languages: [{ key: '/languages/eng' }],
    isbn_13: [isbn13For(9999)],
    title: 'Sample Work',
    authors: [{ key: '/authors/OL1A' }],
    physical_format: 'Paperback',
  });
  const run = (ordered, label) => enrichFixture({
    directory,
    candidates: [discoverCandidate({ title: 'Sample Work' })],
    editions: ordered.join(''),
    authorsIndexPath,
    outputName: `${label}.json`,
    editionsName: `${label}.txt.gz`,
  });
  const forward = await run([...highScoringAudio, printEdition], 'audio-norm-forward');
  const reverse = await run([printEdition, ...highScoringAudio].reverse(), 'audio-norm-reverse');
  const forwardIsbns = forward.artifact.candidates[0].isbns;
  const reverseIsbns = reverse.artifact.candidates[0].isbns;
  assert.equal(forwardIsbns.length, 200);
  assert.deepEqual(reverseIsbns, forwardIsbns);
  assert.equal(forwardIsbns.includes(isbn13For(9999)), true);
  // Audio editions are disqualified from englishIsbns, but fill remaining capacity as lowest non-English/other evidence.
  // The highest audio ISBN (2199) is evicted to make room for print edition 9999.
  assert.equal(forwardIsbns.includes(isbn13For(2199)), false);
});

test('enrich: primary author alignment preserves valid primary author edition against secondary-author editions', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authors = [
    { key: '/authors/OL1A', name: 'Primary Author' },
    { key: '/authors/OL2A', name: 'Secondary Author' },
  ];
  const authorsIndexPath = await writeAuthorIndex(directory, authors);
  const candidates = [
    discoverCandidate({
      workKey: '/works/OL100W',
      title: 'Sample Work',
      authorKeys: ['/authors/OL1A', '/authors/OL2A'],
    }),
  ];
  const primaryEdition = editionLine('/books/OLPRIMARYM', {
    works: [{ key: '/works/OL100W' }],
    languages: [{ key: '/languages/eng' }],
    isbn_13: [isbn13For(9999)],
    title: 'Sample Work',
    authors: [{ key: '/authors/OL1A' }],
  });
  const secondaryEditions = Array.from({ length: 200 }, (_, index) => editionLine(`/books/OLSEC${index}M`, {
    works: [{ key: '/works/OL100W' }],
    languages: [{ key: '/languages/eng' }],
    isbn_13: [isbn13For(1000 + index)],
    title: 'Sample Work',
    authors: [{ key: '/authors/OL2A' }],
    covers: [50],
    publish_date: '2020',
  }));
  const run = (ordered, label) => enrichFixture({
    directory,
    candidates,
    editions: ordered.join(''),
    authorsIndexPath,
    outputName: `${label}.json`,
    editionsName: `${label}.txt.gz`,
  });
  const forward = await run([...secondaryEditions, primaryEdition], 'author-align-forward');
  const reverse = await run([primaryEdition, ...secondaryEditions].reverse(), 'author-align-reverse');
  const forwardIsbns = forward.artifact.candidates[0].isbns;
  const reverseIsbns = reverse.artifact.candidates[0].isbns;
  assert.equal(forwardIsbns.length, 200);
  assert.deepEqual(reverseIsbns, forwardIsbns);
  assert.equal(forwardIsbns.includes(isbn13For(9999)), true);
  assert.equal(forwardIsbns.includes(isbn13For(1199)), false);

  // Duplicate ISBN handling: primary author observed in earlier or later duplicate record retains the higher score.
  const lowDup = editionLine('/books/OLDUP1M', {
    works: [{ key: '/works/OL100W' }],
    languages: [{ key: '/languages/eng' }],
    isbn_13: [isbn13For(9999)],
    title: 'Sample Work',
    authors: [{ key: '/authors/OL2A' }],
  });
  const highDup = primaryEdition;
  const dupLowFirst = await run([lowDup, ...secondaryEditions, highDup], 'dup-author-low-first');
  const dupHighFirst = await run([highDup, ...secondaryEditions, lowDup], 'dup-author-high-first');
  assert.equal(dupLowFirst.artifact.candidates[0].isbns.includes(isbn13For(9999)), true);
  assert.deepEqual(dupLowFirst.artifact.candidates[0].isbns, dupHighFirst.artifact.candidates[0].isbns);
});

// These fixtures exercise retention through the real mapper, scorer and bridge,
// with one eligible contender and 200 editions that bridge must reject.
for (const scenario of [
  { name: 'S6 secondary author with richer metadata', validTitle: 'Sample Work', sourceTitle: 'Sample Work: A Novel', bad: { authors: [{ key: '/authors/OL2A' }] }, validIsbn: 1 },
  { name: 'non-exact title against rich secondary authors', validTitle: 'Work Sample', bad: { authors: [{ key: '/authors/OL2A' }] } },
  { name: 'distinct author key with the same resolved name', validAuthor: '/authors/OL3A', bad: { authors: [{ key: '/authors/OL2A' }] } },
  { name: 'strong author-name match', validAuthor: '/authors/OL4A', bad: { authors: [{ key: '/authors/OL2A' }] } },
  { name: 'eligibility across author-resolution batch boundaries', badCount: 300, bad: { authors: [{ key: '/authors/OL2A' }] } },
  { name: 'missing authors', bad: { authors: [] } },
  { name: 'unresolved first author', bad: { authors: [{ key: '/authors/OL99A' }, { key: '/authors/OL1A' }] } },
  { name: 'unresolved secondary author', bad: { authors: [{ key: '/authors/OL1A' }, { key: '/authors/OL99A' }] } },
  { name: 'malformed nested authors', bad: { authors: [{ author: { key: '/authors/OL1A' } }] } },
  { name: 'unrelated titles', bad: { title: 'Unrelated Title' } },
  { name: 'Study Guide variant', bad: { subtitle: 'Study Guide' } },
  { name: 'A Summary variant', bad: { subtitle: 'A Summary' } },
  ...['Audible', 'Audio', 'Audio book', 'Audio recording', 'large print paperback'].map(physical_format => ({ name: physical_format, bad: { physical_format } })),
]) {
  test(`enrich to bridge eligibility: ${scenario.name}, both dump orders`, async (t) => {
    const directory = await temporaryDirectory();
    let authorLookup;
    t.after(async () => {
      authorLookup?.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    const authorsIndexPath = await writeAuthorIndex(directory, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
      { key: '/authors/OL2A', name: 'Other Writer' },
      { key: '/authors/OL3A', name: 'Austen, Jane' },
      { key: '/authors/OL4A', name: 'J. Austen' },
    ]);
    const candidate = discoverCandidate({ title: scenario.sourceTitle ?? 'Sample Work', authorKeys: ['/authors/OL1A', '/authors/OL2A'] });
    const validIsbn = isbn13For(scenario.validIsbn ?? 9999);
    const valid = englishEdition('/books/OL9999M', scenario.validIsbn ?? 9999, {
      key: '/books/OL9999M', title: scenario.validTitle ?? 'Sample Work',
      authors: [{ key: scenario.validAuthor ?? '/authors/OL1A' }], physical_format: 'Paperback',
    });
    const bad = Array.from({ length: scenario.badCount ?? 200 }, (_, index) => englishEdition(`/books/OL${1000 + index}M`, 1000 + index, {
      key: `/books/OL${1000 + index}M`, title: candidate.title,
      authors: [{ key: '/authors/OL1A' }], covers: [50], publish_date: '2020',
      ...scenario.bad,
    }));
    const lines = [...bad, valid];
    const outcomes = [];
    authorLookup = await createOpenLibraryAuthorLookup({ indexPath: authorsIndexPath, snapshotId: SNAPSHOT_ID });
    for (const [label, ordered] of [['forward', lines], ['reverse', lines.slice().reverse()]]) {
      const enriched = await enrichFixture({
        directory, candidates: [candidate], editions: ordered.join(''), authorsIndexPath,
        outputName: `${label}.json`, editionsName: `${label}.txt.gz`,
      });
      const artifact = sealLanguageCheckedArtifact(enriched.artifact);
      const reportRows = [{ workKey: candidate.workKey, title: candidate.title, status: 'new', matchedBookIds: [], matchedBy: null, languageCheckDigest: artifact.languageCheckDigest }];
      const result = await bridgeCatalogWorks({ artifact, reportRows, records: readOpenLibraryBulkRecords(enriched.editionsPath), authorLookup });
      const entry = result.artifact.entries[0];
      outcomes.push({ label, enriched, entry });
      if (scenario.validIsbn === 1) t.diagnostic(`S6 ${label}: ${entry.status}, ISBN retained=${enriched.artifact.candidates[0].isbns.includes(validIsbn)}, ${entry.diagnostic?.code ?? entry.metadata.isbn}`);
    }
    for (const { label, enriched, entry } of outcomes) {
      assert.equal(entry.status, 'resolved', `${label}: ${entry.diagnostic?.code}`);
      assert.equal(entry.metadata.isbn, validIsbn);
      assert.equal(enriched.artifact.candidates[0].isbns.includes(validIsbn), true);
      assert.equal(enriched.artifact.candidates[0].isbns.length, 200);
      assert.equal(enriched.worksIsbnTruncated, 1);
      validateEnrichedArtifact(JSON.parse(await fs.readFile(enriched.outputPath, 'utf8')));
      assert.deepEqual(enriched.artifact.candidates[0].isbns, outcomes[0].enriched.artifact.candidates[0].isbns);
    }
  });
}

test('enrich to bridge: duplicate ISBN retains eligibility and best completeness, with lowest-ISBN ties', async (t) => {
  const directory = await temporaryDirectory();
  let authorLookup;
  t.after(async () => {
    authorLookup?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const authorsIndexPath = await writeAuthorIndex(directory, AUSTEN);
  authorLookup = await createOpenLibraryAuthorLookup({ indexPath: authorsIndexPath, snapshotId: SNAPSHOT_ID });
  const ordinary = Array.from({ length: 200 }, (_, index) => englishEdition(`/books/OL${1000 + index}M`, 1000 + index, {
    key: `/books/OL${1000 + index}M`, title: 'Sample Work', authors: [{ key: '/authors/OL1A' }],
  }));
  const low = englishEdition('/books/OL9001M', 9000, {
    key: '/books/OL9001M', title: 'Sample Work', authors: [], covers: [1], publish_date: '2020',
  });
  const high = englishEdition('/books/OL9002M', 9000, {
    key: '/books/OL9002M', title: 'Sample Work', authors: [{ key: '/authors/OL1A' }],
    covers: [1], publish_date: '2020', physical_format: 'Paperback',
  });
  const lines = [low, ...ordinary, high];
  const expected = [...Array.from({ length: 199 }, (_, index) => isbn13For(1000 + index)), isbn13For(9000)].sort();
  for (const [label, ordered] of [['forward', lines], ['reverse', lines.slice().reverse()]]) {
    const enriched = await enrichFixture({
      directory, candidates: [discoverCandidate({ title: 'Sample Work' })], editions: ordered.join(''), authorsIndexPath,
      outputName: `${label}.json`, editionsName: `${label}.txt.gz`,
    });
    assert.deepEqual(enriched.artifact.candidates[0].isbns, expected);
    const artifact = sealLanguageCheckedArtifact(enriched.artifact);
    const reportRows = [{ workKey: '/works/OL100W', title: 'Sample Work', status: 'new', matchedBookIds: [], matchedBy: null, languageCheckDigest: artifact.languageCheckDigest }];
    const result = await bridgeCatalogWorks({ artifact, reportRows, records: readOpenLibraryBulkRecords(enriched.editionsPath), authorLookup });
    assert.equal(result.artifact.entries[0].status, 'resolved');
    assert.equal(result.artifact.entries[0].metadata.isbn, isbn13For(9000));
  }
});
