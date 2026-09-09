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

test('ISBN-10 conversion validates its own checksum and produces canonical ISBN-13', () => {
  assert.equal(normalizeIsbn10ToIsbn13('0141439513'), '9780141439518');
  assert.throws(() => normalizeIsbn10ToIsbn13('0141439514'), /Invalid ISBN-10/);
  assert.throws(() => normalizeIsbn10ToIsbn13('not-an-isbn'), /Invalid ISBN-10/);
});

test('Open Library edition dump maps local author keys and edition-only metadata into canonical candidates', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { metadata, lookup } = await authorLookup(directory);
  assert.deepEqual(metadata.statistics, { input: 3, accepted: 2, rejected: 1, conflicts: 0 });
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
});

test('local Open Library author and edition build CLIs require only local dump files', async t => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authorIndex = join(directory, 'authors');
  const editionIndex = join(directory, 'editions');
  const authorScript = join(process.cwd(), 'scripts', 'ol-author-index-build.js');
  const editionScript = join(process.cwd(), 'scripts', 'ol-snapshot-build.js');
  const authorResult = await execFileAsync(process.execPath, [authorScript, '--input', fileURLToPath(AUTHORS), '--output', authorIndex, '--snapshot-id', SNAPSHOT_ID]);
  assert.equal(JSON.parse(authorResult.stdout).statistics.accepted, 2);
  const editionResult = await execFileAsync(process.execPath, [
    editionScript, '--input', fileURLToPath(EDITIONS), '--output', editionIndex, '--author-index', authorIndex, '--snapshot-id', SNAPSHOT_ID,
  ]);
  assert.equal(JSON.parse(editionResult.stdout).recordCount, 6);
});
