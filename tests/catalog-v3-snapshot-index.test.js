import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getCanonicalCandidates } from '../scripts/catalog/canonical-source.js';
import { CatalogContractError } from '../scripts/catalog/contracts.js';
import {
  SNAPSHOT_INDEX_VERSION,
  buildSnapshotIndex,
  createLocalCanonicalAdapter,
  readSnapshotIndexMetadata,
} from '../scripts/catalog/snapshot-index.js';
import { readNdjsonSnapshot } from '../scripts/catalog/snapshot-reader.js';

const FIXTURE = new URL('./fixtures/catalog-v3-snapshot.ndjson', import.meta.url);
const SOURCE_NAME = 'fixture-canonical';
const SNAPSHOT_ID = 'fixture-2026-09';
const ISBN_A = '9780141439518';
const ISBN_B = '9780451524935';
const execFileAsync = promisify(execFile);

function source(overrides = {}) {
  return { key: 'pride-and-prejudice-jane-austen', title: 'Pride and Prejudice', author: 'Jane Austen', ...overrides };
}

async function temporaryIndex(records = readNdjsonSnapshot(FIXTURE)) {
  const directory = await mkdtemp(join(tmpdir(), 'bookish-snapshot-index-'));
  const indexPath = join(directory, 'index');
  const metadata = await buildSnapshotIndex({ records, outputPath: indexPath, sourceName: SOURCE_NAME, snapshotId: SNAPSHOT_ID, generatedAt: '2026-09-10T00:00:00.000Z' });
  return { directory, indexPath, metadata };
}

test('streaming snapshot build persists a versioned sharded index and tracks bad/duplicate records', async t => {
  const { directory, indexPath, metadata } = await temporaryIndex();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.equal(metadata.indexVersion, SNAPSHOT_INDEX_VERSION);
  assert.equal(metadata.recordCount, 3);
  assert.deepEqual(metadata.statistics, {
    input: 6, accepted: 3, rejected: 2, duplicateIsbnGroups: 1,
    conflictingDuplicateIsbnGroups: 1, duplicateRecords: 1,
    rejectionCodes: { invalid_canonical_isbn: 1, malformed_canonical_value: 1 },
  });
  assert.deepEqual(await readSnapshotIndexMetadata(indexPath), metadata);
});

test('local canonical adapter prioritizes pinned/preferred exact ISBN then title-author candidates', async t => {
  const { directory, indexPath } = await temporaryIndex();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const adapter = await createLocalCanonicalAdapter({ indexPath });
  const preferred = await getCanonicalCandidates(adapter, source({ preferredIsbn13: ISBN_B }));
  assert.deepEqual(preferred.map(candidate => candidate.isbn13), [ISBN_B, ISBN_A]);
  const pinned = await getCanonicalCandidates(adapter, source({ preferredIsbn13: ISBN_A, pinnedIsbn13: ISBN_A }));
  assert.deepEqual(pinned.map(candidate => candidate.isbn13), [ISBN_A, ISBN_A, ISBN_B]);
  assert.deepEqual(pinned.map(candidate => candidate.recordId), ['edition-conflict', 'edition-pride-1', 'edition-pride-2']);
  const titleOnly = await getCanonicalCandidates(adapter, source());
  assert.deepEqual(titleOnly.map(candidate => candidate.isbn13), [ISBN_A, ISBN_B]);
});

test('index results are deterministic regardless of input order', async t => {
  const rows = [];
  for await (const row of readNdjsonSnapshot(FIXTURE)) rows.push(row);
  const reverse = (async function* () { for (const row of [...rows].reverse()) yield row; }());
  const first = await temporaryIndex((async function* () { for (const row of rows) yield row; }()));
  const second = await temporaryIndex(reverse);
  t.after(() => Promise.all([fs.rm(first.directory, { recursive: true, force: true }), fs.rm(second.directory, { recursive: true, force: true })]));
  const firstAdapter = await createLocalCanonicalAdapter({ indexPath: first.indexPath });
  const secondAdapter = await createLocalCanonicalAdapter({ indexPath: second.indexPath });
  const [firstCandidates, secondCandidates] = await Promise.all([
    getCanonicalCandidates(firstAdapter, source()),
    getCanonicalCandidates(secondAdapter, source()),
  ]);
  assert.deepEqual(firstCandidates, secondCandidates);
  assert.deepEqual(first.metadata.statistics, second.metadata.statistics);
});

test('adapter rejects incompatible metadata and records that violate snapshot identity', async t => {
  const { directory, indexPath } = await temporaryIndex();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const metadataPath = join(indexPath, 'index.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, indexVersion: 999 }), 'utf8');
  await assert.rejects(createLocalCanonicalAdapter({ indexPath }), error => error instanceof CatalogContractError && error.code === 'invalid_snapshot_index_version');

  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, canonicalContractVersion: 999 }), 'utf8');
  await assert.rejects(createLocalCanonicalAdapter({ indexPath }), error => error instanceof CatalogContractError && error.code === 'invalid_canonical_contract_version');

  await fs.writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
  const recordDirectory = join(indexPath, 'records');
  const files = await fs.readdir(recordDirectory);
  const recordFile = await (async () => {
    for (const file of files) {
      const rows = (await fs.readFile(join(recordDirectory, file), 'utf8')).trim().split('\n').map(JSON.parse);
      if (rows.some(row => row.candidate.title === 'Pride and Prejudice')) return { path: join(recordDirectory, file), rows };
    }
    throw new Error('Fixture record was not indexed');
  })();
  const path = recordFile.path;
  const rows = recordFile.rows;
  rows.find(row => row.candidate.title === 'Pride and Prejudice').candidate.snapshotId = 'wrong-snapshot';
  await fs.writeFile(path, `${rows.map(JSON.stringify).join('\n')}\n`, 'utf8');
  const adapter = await createLocalCanonicalAdapter({ indexPath });
  await assert.rejects(
    getCanonicalCandidates(adapter, source()),
    error => error instanceof CatalogContractError && error.code === 'snapshot_identity_mismatch',
  );
});

test('generated thousands-record stream builds and queries without an input array', async t => {
  const total = 5000;
  let yielded = 0;
  async function* records() {
    for (let index = 0; index < total; index++) {
      yielded += 1;
      const isbn = `978000000${String(index).padStart(4, '0')}`;
      // Valid synthetic ISBNs are derived from a valid prefix plus its computed check digit.
      const digits = isbn.slice(0, 12).split('').map(Number);
      const check = (10 - (digits.reduce((sum, digit, position) => sum + digit * (position % 2 ? 3 : 1), 0) % 10)) % 10;
      yield {
        recordId: `record-${index}`, snapshotId: SNAPSHOT_ID, sourceName: SOURCE_NAME, isbn13: `${isbn.slice(0, 12)}${check}`,
        title: `Synthetic Book ${index}`, subtitle: null, authors: [`Author ${index}`], language: 'en', publisher: null,
        publicationDate: null, publicationYear: null, format: null, cover: null, description: null, subjects: [], sourceIdentifiers: {},
      };
    }
  }
  const { directory, indexPath, metadata } = await temporaryIndex(records());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.equal(yielded, total);
  assert.equal(metadata.recordCount, total);
  const adapter = await createLocalCanonicalAdapter({ indexPath });
  const candidates = await getCanonicalCandidates(adapter, {
    key: 'synthetic-book-4321-author-4321', title: 'Synthetic Book 4321', author: 'Author 4321',
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].recordId, 'record-4321');
});

test('local build and status CLIs report only snapshot index metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bookish-snapshot-cli-'));
  const indexPath = join(directory, 'index');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const buildScript = join(process.cwd(), 'scripts', 'snapshot-build.js');
  const statusScript = join(process.cwd(), 'scripts', 'snapshot-status.js');
  const build = await execFileAsync(process.execPath, [
    buildScript, '--input', fileURLToPath(FIXTURE), '--output', indexPath, '--source-name', SOURCE_NAME, '--snapshot-id', SNAPSHOT_ID,
  ]);
  assert.equal(JSON.parse(build.stdout).recordCount, 3);
  const status = await execFileAsync(process.execPath, [statusScript, '--index', indexPath, '--json']);
  assert.equal(JSON.parse(status.stdout).statistics.rejected, 2);
});
