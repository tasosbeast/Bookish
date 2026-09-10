import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { calculateDiskPreflight, preflightDiskCapacity } from '../scripts/catalog/disk-preflight.js';
import { runOpenLibraryBulkSmoke } from '../scripts/catalog/bulk-smoke.js';
import { downloadOpenLibraryRangeSample } from '../scripts/catalog/open-library-sample.js';

const execFileAsync = promisify(execFile);

test('disk preflight calculates conservative required space and refuses insufficient capacity', () => {
  const pass = calculateDiskPreflight({
    freeBytes: 1000, inputBytes: 100, amplification: 4, safetyReserveBytes: 200,
  });
  assert.deepEqual(pass, {
    freeBytes: 1000, inputBytes: 100, amplification: 4, estimatedPeakTemporaryBytes: 400,
    safetyReserveBytes: 200, requiredBytes: 600, availableAfterBuildBytes: 400, status: 'pass',
  });
  const insufficient = calculateDiskPreflight({
    freeBytes: 599, inputBytes: 100, amplification: 4, safetyReserveBytes: 200,
  });
  assert.equal(insufficient.status, 'insufficient_space');
  assert.equal(insufficient.availableAfterBuildBytes, -1);
});

test('disk preflight reads the selected filesystem and input file without writing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bookish-disk-preflight-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, 'sample.gz');
  await fs.writeFile(inputPath, Buffer.alloc(128));
  const result = await preflightDiskCapacity({ directory, inputPath, amplification: 1, safetyReserveBytes: 0 });
  assert.equal(result.inputBytes, 128);
  assert.equal(result.estimatedPeakTemporaryBytes, 128);
  assert.ok(result.freeBytes > 0);
  assert.equal(result.status, 'pass');
});

test('disk preflight CLI reports machine-readable capacity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bookish-disk-preflight-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, 'sample.gz');
  await fs.writeFile(inputPath, Buffer.alloc(64));
  const script = join(process.cwd(), 'scripts', 'catalog-disk-preflight.js');
  const success = await execFileAsync(process.execPath, [script, '--directory', directory, '--input', inputPath, '--amplification', '1', '--reserve-bytes', '0', '--json']);
  assert.equal(JSON.parse(success.stdout).inputBytes, 64);
});

test('local bulk smoke records build metrics and verifies offline lookups', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bookish-bulk-smoke-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authorsPath = fileURLToPath(new URL('./fixtures/open-library-authors.txt', import.meta.url));
  const editionsPath = fileURLToPath(new URL('./fixtures/open-library-editions.txt', import.meta.url));
  const result = await runOpenLibraryBulkSmoke({
    authorsPath, editionsPath, workingDirectory: directory, snapshotId: 'bulk-smoke-fixture', sortChunkSize: 1, maxOpenRuns: 2,
  });
  assert.equal(result.author.statistics.accepted, 2);
  assert.equal(result.edition.statistics.accepted, 6);
  assert.ok(result.author.indexBytes > 0);
  assert.ok(result.edition.indexBytes > 0);
  assert.ok(result.lookups.length > 0);
  assert.ok(result.observation.peakRssBytes > 0);
  assert.ok(result.observation.peakWorkspaceBytes > 0);
  await assert.rejects(fs.access(result.root));
});

test('range sampler requires a bounded HTTP range and writes only complete local rows', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bookish-ol-range-sample-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'authors.txt');
  const sourceRows = '/type/author\t/authors/OL1A\t1\t2026-01-01\t{"name":"Fixture Author"}\n/type/author\t/authors/OL2A\t1\t2026-01-01\t{"name":"Second Author"}\n';
  const payload = gzipSync(sourceRows);
  let request;
  const result = await downloadOpenLibraryRangeSample({
    url: 'https://example.test/ol_dump_authors_latest.txt.gz', outputPath, byteLimit: payload.length, rowLimit: 1,
    fetchImpl: async (...args) => {
      request = args;
      return { status: 206, headers: { get: key => key === 'content-range' ? `bytes 0-${payload.length - 1}/${payload.length}` : null }, body: Readable.toWeb(Readable.from([payload])) };
    },
  });
  assert.equal(request[1].headers.Range, `bytes=0-${payload.length - 1}`);
  assert.equal(result.downloadedBytes, payload.length);
  assert.equal(result.rows, 1);
  assert.match(await fs.readFile(outputPath, 'utf8'), /Fixture Author/);
  await assert.rejects(downloadOpenLibraryRangeSample({
    url: 'https://example.test/ol_dump_authors_latest.txt.gz', outputPath: join(directory, 'reject.txt'), byteLimit: 10, rowLimit: 1,
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body: null }),
  }), /HTTP 206/);
});
