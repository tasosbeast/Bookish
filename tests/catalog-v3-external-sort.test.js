import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCanonicalCandidates } from '../scripts/catalog/canonical-source.js';
import { buildOpenLibraryAuthorIndex, createOpenLibraryAuthorLookup } from '../scripts/catalog/open-library-bulk.js';
import { buildSnapshotIndex, createLocalCanonicalAdapter } from '../scripts/catalog/snapshot-index.js';

const SOURCE_NAME = 'external-sort-fixture';
const SNAPSHOT_ID = 'external-sort-2026-09';

function isbn13For(index) {
  const firstTwelve = `978${String(index).padStart(9, '0')}`;
  const check = (10 - ([...firstTwelve].reduce((sum, digit, position) => sum + Number(digit) * (position % 2 ? 3 : 1), 0) % 10)) % 10;
  return `${firstTwelve}${check}`;
}

function candidate(index, overrides = {}) {
  return {
    recordId: `record-${index}`, snapshotId: SNAPSHOT_ID, sourceName: SOURCE_NAME, isbn13: isbn13For(index),
    title: `External Sort Book ${index}`, subtitle: null, authors: [`Author ${index}`], language: 'en', publisher: null,
    publicationDate: null, publicationYear: null, format: null, cover: null, description: null, subjects: [], sourceIdentifiers: {}, ...overrides,
  };
}

async function* records(total, reverse = false) {
  for (let offset = 0; offset < total; offset++) {
    const index = reverse ? total - offset - 1 : offset;
    if (index === 1) yield candidate(index, { isbn13: isbn13For(0), title: 'Conflicting ISBN Edition', authors: ['Conflict Author'] });
    else yield candidate(index);
    if (index === 2) yield candidate(index);
  }
}

async function indexDigest(path) {
  const digest = createHash('sha256');
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const nextRelative = `${relative}/${entry.name}`;
      const nextPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(nextPath, nextRelative);
      else {
        digest.update(nextRelative);
        digest.update(await fs.readFile(nextPath));
      }
    }
  }
  await visit(path);
  return digest.digest('hex');
}

async function indexFileDigests(path) {
  const values = new Map();
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const nextRelative = `${relative}/${entry.name}`;
      const nextPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(nextPath, nextRelative);
      else values.set(nextRelative, createHash('sha256').update(await fs.readFile(nextPath)).digest('hex'));
    }
  }
  await visit(path);
  return values;
}

test('external-sort snapshot build stays deterministic with bounded chunks and no retained runs', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'bookish-external-sort-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const firstPath = join(directory, 'first');
  const secondPath = join(directory, 'second');
  const events = [];
  const options = {
    sourceName: SOURCE_NAME, snapshotId: SNAPSHOT_ID, generatedAt: '2026-09-10T00:00:00.000Z',
    sortChunkSize: 256, maxOpenRuns: 4, onSortRun: event => events.push(event),
  };
  const total = 20_000;
  const first = await buildSnapshotIndex({ ...options, records: records(total), outputPath: firstPath });
  const second = await buildSnapshotIndex({ ...options, records: records(total, true), outputPath: secondPath });
  assert.equal(first.recordCount, total);
  assert.equal(first.statistics.duplicateRecords, 1);
  assert.equal(first.statistics.duplicateIsbnGroups, 2);
  assert.equal(first.statistics.conflictingDuplicateIsbnGroups, 1);
  assert.ok(events.some(event => event.type === 'created'));
  assert.ok(events.some(event => event.type === 'merged'));
  await assert.rejects(fs.access(join(firstPath, 'runs')));
  await assert.rejects(fs.access(join(firstPath, 'dedupe-source')));
  await assert.rejects(fs.access(join(firstPath, 'isbn-source')));
  const firstDigest = await indexDigest(firstPath);
  const secondDigest = await indexDigest(secondPath);
  if (firstDigest !== secondDigest) {
    const firstFiles = await indexFileDigests(firstPath);
    const secondFiles = await indexFileDigests(secondPath);
    const differingFile = [...firstFiles.keys()].find(key => firstFiles.get(key) !== secondFiles.get(key));
    assert.fail(`Deterministic index mismatch in ${differingFile}`);
  }

  const adapter = await createLocalCanonicalAdapter({ indexPath: firstPath });
  const target = 17_321;
  const candidates = await getCanonicalCandidates(adapter, {
    key: `external-sort-book-${target}-author-${target}`, title: `External Sort Book ${target}`, author: `Author ${target}`, preferredIsbn13: isbn13For(target),
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].recordId, `record-${target}`);
});

test('external-sort author build deduplicates identical names and retains conflicts deterministically', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'bookish-external-authors-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, 'authors.txt');
  const row = name => `/type/author\t/authors/OLX1A\t1\t2026-01-01T00:00:00.000000\t${JSON.stringify({ name })}\n`;
  await fs.writeFile(inputPath, `${row('First Name')}${row('First Name')}${row('Second Name')}`, 'utf8');
  const events = [];
  const indexPath = join(directory, 'index');
  const metadata = await buildOpenLibraryAuthorIndex({
    inputPath, outputPath: indexPath, snapshotId: SNAPSHOT_ID, generatedAt: '2026-09-10T00:00:00.000Z',
    sortChunkSize: 1, maxOpenRuns: 2, onSortRun: event => events.push(event),
  });
  assert.deepEqual(metadata.statistics, { input: 3, accepted: 2, rejected: 0, duplicates: 1, conflicts: 1 });
  assert.ok(events.some(event => event.type === 'merged'));
  await assert.rejects(fs.access(join(indexPath, 'runs')));
  const lookup = await createOpenLibraryAuthorLookup({ indexPath, snapshotId: SNAPSHOT_ID });
  assert.equal((await lookup.getNames(['/authors/OLX1A'])).size, 0);
});

test('failed external-sort rebuilds preserve the prior complete indexes and clean their temp directories', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'bookish-external-atomic-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const snapshotPath = join(directory, 'snapshot');
  const authorPath = join(directory, 'authors');
  const fixedOptions = { snapshotId: SNAPSHOT_ID, generatedAt: '2026-09-10T00:00:00.000Z', sortChunkSize: 1, maxOpenRuns: 2 };

  await buildSnapshotIndex({ ...fixedOptions, records: records(1), outputPath: snapshotPath, sourceName: SOURCE_NAME });
  const snapshotBefore = await indexDigest(snapshotPath);
  async function* failingRecords() {
    yield candidate(99);
    throw new Error('simulated snapshot stream failure');
  }
  await assert.rejects(buildSnapshotIndex({ ...fixedOptions, records: failingRecords(), outputPath: snapshotPath, sourceName: SOURCE_NAME }), /simulated snapshot stream failure/);
  assert.equal(await indexDigest(snapshotPath), snapshotBefore);

  const authorInput = join(directory, 'authors.txt');
  await fs.writeFile(authorInput, `/type/author\t/authors/OLX1A\t1\t2026-01-01T00:00:00.000000\t${JSON.stringify({ name: 'First Name' })}\n`, 'utf8');
  await buildOpenLibraryAuthorIndex({ ...fixedOptions, inputPath: authorInput, outputPath: authorPath });
  const authorBefore = await indexDigest(authorPath);
  await assert.rejects(buildOpenLibraryAuthorIndex({ ...fixedOptions, inputPath: join(directory, 'missing-authors.txt'), outputPath: authorPath }));
  assert.equal(await indexDigest(authorPath), authorBefore);
  const leftovers = await fs.readdir(directory);
  assert.equal(leftovers.some(name => name.includes('.building-') || name.includes('.previous-')), false);
});
