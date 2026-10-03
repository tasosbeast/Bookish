import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildOpenLibraryAuthorIndex } from '../scripts/catalog/open-library-bulk.js';
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

async function writeAuthorIndex(directory, authors, snapshotId = SNAPSHOT_ID) {
  const inputPath = join(directory, 'authors.txt');
  const indexPath = join(directory, 'author-index');
  await fs.writeFile(inputPath, authors.map(author => authorLine(author.key, author.name)).join(''));
  await buildOpenLibraryAuthorIndex({
    inputPath,
    outputPath: indexPath,
    snapshotId,
    generatedAt: GENERATED_AT,
  });
  return indexPath;
}

async function enrichFixture({
  directory,
  candidates,
  editions,
  authors,
  snapshotId = SNAPSHOT_ID,
  authorSnapshotId = snapshotId,
  progressInterval = 1,
  outputName = 'enriched.json',
}) {
  const inputPath = join(directory, 'discover.json');
  const editionsPath = join(directory, 'ol_dump_editions_fixture.txt.gz');
  const outputPath = join(directory, outputName);
  await fs.writeFile(inputPath, `${JSON.stringify(discoverArtifact(candidates, snapshotId))}\n`);
  await writeGzip(editionsPath, editions);
  const authorsIndexPath = await writeAuthorIndex(directory, authors, authorSnapshotId);
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
  assert.ok(result.progress.length >= 1);
  assert.equal(result.progress.at(-1).matchedEditions, 2);
  assert.equal(result.progress.at(-1).worksWithIsbns, 1);
  const written = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
  validateEnrichedArtifact(written, { snapshotId: SNAPSHOT_ID });
  const loaded = await loadDiscoverCandidates(result.outputPath);
  assert.deepEqual(loaded[0].isbns, ['9780141439518', '9780804429573']);
  assert.equal(loaded[0].primaryAuthor, 'Jane Austen');
});

test('enrich caps ISBNs at 50 per work', async (t) => {
  assert.equal(CATALOG_ENRICH_MAX_ISBNS, 50);
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const isbns = Array.from({ length: 51 }, (_, index) => isbn13For(index));
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
  assert.equal(result.artifact.candidates[0].isbns.length, 50);
  assert.equal(result.artifact.candidates[0].isbns[0], isbn13For(0));
  assert.equal(result.artifact.candidates[0].isbns[49], isbn13For(49));
  assert.equal(result.artifact.candidates[0].isbns.includes(isbn13For(50)), false);
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
    authors: [{ key: '/authors/OL1A', name: 'Jane Austen' }],
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
