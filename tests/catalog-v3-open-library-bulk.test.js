import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getCanonicalCandidates } from '../scripts/catalog/canonical-source.js';
import { normalizeIsbn10ToIsbn13 } from '../scripts/catalog/normalize.js';
import {
  buildOpenLibraryAuthorIndex,
  buildOpenLibraryAuthorLookup,
  createOpenLibraryAuthorLookup,
  readOpenLibraryEditionCandidates,
} from '../scripts/catalog/open-library-bulk.js';
import { buildSnapshotIndex, createLocalCanonicalAdapter } from '../scripts/catalog/snapshot-index.js';
import { SnapshotRecordError } from '../scripts/catalog/snapshot-reader.js';

const AUTHORS = new URL('./fixtures/open-library-authors.txt', import.meta.url);
const EDITIONS = new URL('./fixtures/open-library-editions.txt', import.meta.url);
const SNAPSHOT_ID = 'ol-fixture-2026-09';
const execFileAsync = promisify(execFile);

async function temporaryDirectory() {
  return fs.mkdtemp(join(tmpdir(), 'bookish-ol-bulk-'));
}

async function authorLookup(directory) {
  const authorIndex = join(directory, 'authors');
  const metadata = await buildOpenLibraryAuthorIndex({ inputPath: fileURLToPath(AUTHORS), outputPath: authorIndex, snapshotId: SNAPSHOT_ID, generatedAt: '2026-09-10T00:00:00.000Z' });
  await buildOpenLibraryAuthorLookup({ indexPath: authorIndex, snapshotId: SNAPSHOT_ID, batchSize: 1 });
  return { metadata, authorIndex, lookup: await createOpenLibraryAuthorLookup({ indexPath: authorIndex, snapshotId: SNAPSHOT_ID }) };
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function isbn13For(index) {
  const firstTwelve = `978${String(index).padStart(9, '0')}`;
  const check = (10 - ([...firstTwelve].reduce((sum, digit, position) => sum + Number(digit) * (position % 2 ? 3 : 1), 0) % 10)) % 10;
  return `${firstTwelve}${check}`;
}

function dumpLine({ key, title, isbn13 }) {
  return `/type/edition\t${key}\t1\t2026-01-01T00:00:00.000000\t${JSON.stringify({ title, authors: [{ key: '/authors/OL1A' }], isbn_13: [isbn13], languages: [{ key: '/languages/eng' }] })}\n`;
}

function authorDumpLine({ key, name }) {
  return `/type/author\t${key}\t1\t2026-01-01T00:00:00.000000\t${JSON.stringify({ name })}\n`;
}

test('ISBN-10 conversion validates its own checksum and produces canonical ISBN-13', () => {
  assert.equal(normalizeIsbn10ToIsbn13('0141439513'), '9780141439518');
  assert.throws(() => normalizeIsbn10ToIsbn13('0141439514'), /Invalid ISBN-10/);
  assert.throws(() => normalizeIsbn10ToIsbn13('not-an-isbn'), /Invalid ISBN-10/);
});

test('author lookup lazily caches complete parsed shards while preserving unresolved semantics', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, 'authors.txt');
  const authorIndex = join(directory, 'author-index');
  const conflictKey = '/authors/OLCONFLICTA';
  const authors = Array.from({ length: 128 }, (_, index) => ({
    key: `/authors/OLCACHE${index}A`,
    name: `Cached Author ${index}`,
  }));
  await fs.writeFile(inputPath, [
    ...authors.map(authorDumpLine),
    authorDumpLine({ key: conflictKey, name: 'Conflicting Author One' }),
    authorDumpLine({ key: conflictKey, name: 'Conflicting Author Two' }),
  ].join(''));
  await buildOpenLibraryAuthorIndex({
    inputPath,
    outputPath: authorIndex,
    snapshotId: SNAPSHOT_ID,
    generatedAt: '2026-09-10T00:00:00.000Z',
  });

  const shardsPath = join(authorIndex, 'authors');
  const shards = new Map(await Promise.all((await fs.readdir(shardsPath)).map(async file => [
    file,
    (await fs.readFile(join(shardsPath, file), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
  ])));
  const reusableShard = [...shards].find(([, rows]) => rows.filter(row => row.key !== conflictKey).length >= 2);
  const otherShard = [...shards].find(([file, rows]) => file !== reusableShard?.[0] && rows.some(row => row.key !== conflictKey));
  assert.ok(reusableShard, 'synthetic index should contain two authors in one shard');
  assert.ok(otherShard, 'synthetic index should contain authors in a different shard');
  const [reusableFile, reusableRows] = reusableShard;
  const [first, second] = reusableRows.filter(row => row.key !== conflictKey);
  const other = otherShard[1].find(row => row.key !== conflictKey);

  const lookup = await createOpenLibraryAuthorLookup({ indexPath: authorIndex, snapshotId: SNAPSHOT_ID });
  assert.equal((await lookup.getNames([first.key])).get(first.key), first.name);
  assert.equal((await lookup.getNames([first.key])).get(first.key), first.name);
  assert.equal((await lookup.getNames([other.key])).get(other.key), other.name);
  assert.equal((await lookup.getNames([conflictKey])).has(conflictKey), false);

  await fs.rename(join(shardsPath, reusableFile), join(directory, reusableFile));
  assert.equal((await lookup.getNames([second.key])).get(second.key), second.name);
  assert.equal((await lookup.getNames([first.key])).get(first.key), first.name);
  assert.equal((await lookup.getNames(['/authors/OLMISSINGA'])).has('/authors/OLMISSINGA'), false);
  await assert.rejects(
    createOpenLibraryAuthorLookup({ indexPath: authorIndex, snapshotId: 'different-snapshot' }),
    error => error.code === 'author_snapshot_mismatch',
  );
});

test('SQLite author lookup builds from the author index without materializing NDJSON shards', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, 'authors.txt');
  const authorIndex = join(directory, 'author-index');
  await fs.writeFile(inputPath, [
    authorDumpLine({ key: '/authors/OLUNIQUEA', name: 'Unique Author' }),
    authorDumpLine({ key: '/authors/OLSECONDA', name: 'Second Author' }),
    authorDumpLine({ key: '/authors/OLCONFLICTA', name: 'Conflict One' }),
    authorDumpLine({ key: '/authors/OLCONFLICTA', name: 'Conflict Two' }),
  ].join(''));
  await buildOpenLibraryAuthorIndex({ inputPath, outputPath: authorIndex, snapshotId: SNAPSHOT_ID, generatedAt: '2026-09-10T00:00:00.000Z' });
  const built = await buildOpenLibraryAuthorLookup({ indexPath: authorIndex, snapshotId: SNAPSHOT_ID, batchSize: 1 });
  assert.equal(built.sourceAuthorCount, 4);
  assert.equal(built.authorCount, 3);
  assert.equal(built.conflictedCount, 1);

  await fs.rename(join(authorIndex, 'authors'), join(authorIndex, 'authors-hidden'));
  const lookup = await createOpenLibraryAuthorLookup({ indexPath: authorIndex, snapshotId: SNAPSHOT_ID });
  try {
    const names = await lookup.getNames(['/authors/OLUNIQUEA', '/authors/OLSECONDA', '/authors/OLCONFLICTA', '/authors/OLMISSINGA']);
    assert.deepEqual([...names], [['/authors/OLUNIQUEA', 'Unique Author'], ['/authors/OLSECONDA', 'Second Author']]);
  } finally {
    lookup.close();
  }
  const indexFile = join(authorIndex, 'index.json');
  const changedMetadata = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  changedMetadata.snapshotId = 'different-snapshot';
  await fs.writeFile(indexFile, `${JSON.stringify(changedMetadata)}\n`);
  await assert.rejects(
    createOpenLibraryAuthorLookup({ indexPath: authorIndex, snapshotId: 'different-snapshot' }),
    error => error.code === 'author_snapshot_mismatch',
  );
});

test('invalid SQLite lookup fails instead of falling back to NDJSON', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authorIndex = join(directory, 'authors');
  await buildOpenLibraryAuthorIndex({ inputPath: fileURLToPath(AUTHORS), outputPath: authorIndex, snapshotId: SNAPSHOT_ID, generatedAt: '2026-09-10T00:00:00.000Z' });
  await fs.writeFile(join(authorIndex, 'lookup.sqlite'), 'not a SQLite database');
  await assert.rejects(createOpenLibraryAuthorLookup({ indexPath: authorIndex, snapshotId: SNAPSHOT_ID }));
});

test('failed SQLite temp build preserves an existing known-good lookup', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authorIndex = join(directory, 'authors');
  await buildOpenLibraryAuthorIndex({ inputPath: fileURLToPath(AUTHORS), outputPath: authorIndex, snapshotId: SNAPSHOT_ID, generatedAt: '2026-09-10T00:00:00.000Z' });
  await buildOpenLibraryAuthorLookup({ indexPath: authorIndex, snapshotId: SNAPSHOT_ID, batchSize: 1 });
  const shard = (await fs.readdir(join(authorIndex, 'authors'))).find(file => file.endsWith('.ndjson'));
  await fs.appendFile(join(authorIndex, 'authors', shard), '{broken-json\n');
  await assert.rejects(buildOpenLibraryAuthorLookup({ indexPath: authorIndex, snapshotId: SNAPSHOT_ID, batchSize: 1 }));
  const lookup = await createOpenLibraryAuthorLookup({ indexPath: authorIndex, snapshotId: SNAPSHOT_ID });
  try {
    assert.equal((await lookup.getNames(['/authors/OL1A'])).get('/authors/OL1A'), 'Jane Austen');
  } finally {
    lookup.close();
  }
  assert.deepEqual((await fs.readdir(authorIndex)).filter(name => name.includes('.building-')), []);
});

test('Open Library edition dump maps local author keys and edition-only metadata into canonical candidates', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { metadata, lookup } = await authorLookup(directory);
  assert.deepEqual(metadata.statistics, { input: 3, accepted: 2, rejected: 1, duplicates: 0, conflicts: 0 });
  const records = await collect(readOpenLibraryEditionCandidates({ inputPath: fileURLToPath(EDITIONS), snapshotId: SNAPSHOT_ID, authorLookup: lookup }));
  const candidates = records.filter(record => !(record instanceof SnapshotRecordError));
  const errors = records.filter(record => record instanceof SnapshotRecordError);
  assert.equal(candidates.length, 6);
  assert.deepEqual(candidates.filter(candidate => candidate.recordId === '/books/OLPRIDE1M').map(candidate => candidate.isbn13), ['9780141439518', '9780451524935']);
  const pride = candidates.find(candidate => candidate.recordId === '/books/OLPRIDE1M' && candidate.isbn13 === '9780141439518');
  assert.deepEqual(pride.authors, ['Jane Austen', 'John Doe']);
  assert.equal(pride.language, 'en');
  assert.equal(pride.format, 'paperback');
  assert.deepEqual(pride.cover, { url: null, reference: 'open_library_cover_id:123' });
  assert.deepEqual(pride.sourceIdentifiers, {
    openLibraryEdition: '/books/OLPRIDE1M', openLibraryWorks: '/works/OLPRIDEW', openLibraryAuthors: '/authors/OL1A,/authors/OL2A',
  });
  assert.equal(candidates.find(candidate => candidate.recordId === '/books/OLPRIDE10M').isbn13, '9780141439518');
  assert.equal(candidates.find(candidate => candidate.recordId === '/books/OLNONENM').language, 'fre');
  assert.equal(candidates.find(candidate => candidate.recordId === '/books/OLAUDIOM').format, 'audiobook');
  assert.equal(candidates.find(candidate => candidate.recordId === '/books/OLYEARCONFLICTM').publicationYear, null);
  assert.deepEqual(errors.map(error => error.code).sort(), ['invalid_json', 'malformed_isbn_identifier', 'missing_author', 'no_usable_isbn', 'wrong_record_type']);
  lookup.close();
});

test('gzip-compressed dump input produces the same candidates without network access', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const gzipPath = join(directory, 'editions.txt.gz');
  await fs.writeFile(gzipPath, gzipSync(await fs.readFile(fileURLToPath(EDITIONS))));
  const { lookup } = await authorLookup(directory);
  const records = await collect(readOpenLibraryEditionCandidates({ inputPath: gzipPath, snapshotId: SNAPSHOT_ID, authorLookup: lookup }));
  assert.equal(records.filter(record => !(record instanceof SnapshotRecordError)).length, 6);
  assert.equal(records.filter(record => record instanceof SnapshotRecordError).length, 5);
  lookup.close();
});

test('edition candidate stream feeds the snapshot index and supports exact pinned ISBN lookup', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { lookup } = await authorLookup(directory);
  const indexPath = join(directory, 'editions-index');
  const metadata = await buildSnapshotIndex({
    records: readOpenLibraryEditionCandidates({ inputPath: fileURLToPath(EDITIONS), snapshotId: SNAPSHOT_ID, authorLookup: lookup }),
    outputPath: indexPath, sourceName: 'open-library-bulk', snapshotId: SNAPSHOT_ID, generatedAt: '2026-09-10T00:00:00.000Z',
  });
  assert.equal(metadata.recordCount, 6);
  assert.equal(metadata.statistics.rejected, 5);
  const adapter = await createLocalCanonicalAdapter({ indexPath });
  const candidates = await getCanonicalCandidates(adapter, {
    key: 'pride-and-prejudice-jane-austen', title: 'Pride and Prejudice', author: 'Jane Austen',
    preferredIsbn13: '9780141439518', pinnedIsbn13: '9780141439518',
  });
  assert.equal(candidates[0].isbn13, '9780141439518');
  assert.ok(candidates.some(candidate => candidate.isbn13 === '9780451524935'));
  lookup.close();
});

test('several thousand local edition rows stream through parser and index without an input array', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const editionsPath = join(directory, 'large-editions.txt');
  const handle = await fs.open(editionsPath, 'w');
  const total = 3000;
  try {
    for (let index = 0; index < total; index++) await handle.writeFile(dumpLine({ key: `/books/OLSYN${index}M`, title: `Synthetic Edition ${index}`, isbn13: isbn13For(index) }));
  } finally {
    await handle.close();
  }
  const { lookup } = await authorLookup(directory);
  const indexPath = join(directory, 'large-index');
  const metadata = await buildSnapshotIndex({
    records: readOpenLibraryEditionCandidates({ inputPath: editionsPath, snapshotId: SNAPSHOT_ID, authorLookup: lookup }),
    outputPath: indexPath, sourceName: 'open-library-bulk', snapshotId: SNAPSHOT_ID,
  });
  assert.equal(metadata.recordCount, total);
  const adapter = await createLocalCanonicalAdapter({ indexPath });
  const target = 2431;
  const candidates = await getCanonicalCandidates(adapter, {
    key: `synthetic-edition-${target}-jane-austen`, title: `Synthetic Edition ${target}`, author: 'Jane Austen', preferredIsbn13: isbn13For(target),
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].recordId, `/books/OLSYN${target}M`);
  lookup.close();
});

test('local Open Library author and edition build CLIs require only local dump files', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authorIndex = join(directory, 'authors');
  const editionIndex = join(directory, 'editions');
  const authorScript = join(process.cwd(), 'scripts', 'ol-author-index-build.js');
  const lookupScript = join(process.cwd(), 'scripts', 'ol-author-lookup-build.js');
  const editionScript = join(process.cwd(), 'scripts', 'ol-snapshot-build.js');
  const authorResult = await execFileAsync(process.execPath, [authorScript, '--input', fileURLToPath(AUTHORS), '--output', authorIndex, '--snapshot-id', SNAPSHOT_ID]);
  assert.equal(JSON.parse(authorResult.stdout).statistics.accepted, 2);
  const lookupResult = await execFileAsync(process.execPath, ['--experimental-sqlite', lookupScript, '--index', authorIndex, '--snapshot-id', SNAPSHOT_ID]);
  assert.equal(JSON.parse(lookupResult.stdout).authorCount, 2);
  const rebuiltLookup = await execFileAsync(process.execPath, ['--experimental-sqlite', lookupScript, '--index', authorIndex, '--snapshot-id', SNAPSHOT_ID]);
  assert.equal(JSON.parse(rebuiltLookup.stdout).authorCount, 2);
  const editionResult = await execFileAsync(process.execPath, [
    '--experimental-sqlite', editionScript, '--input', fileURLToPath(EDITIONS), '--output', editionIndex, '--author-index', authorIndex, '--snapshot-id', SNAPSHOT_ID,
  ]);
  assert.equal(JSON.parse(editionResult.stdout).recordCount, 6);
});
