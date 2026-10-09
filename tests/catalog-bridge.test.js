import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { bridgeCatalogWorks, runCatalogBridge } from '../scripts/catalog/bridge.js';
import { CATALOG_DISCOVER_FILTER_REASONS, CATALOG_DISCOVER_FORMAT, CATALOG_DISCOVER_SCORING, CATALOG_DISCOVER_VERSION, popularityScore } from '../scripts/catalog/discover.js';
import { importResolvedCatalog, validateImportArtifact } from '../scripts/catalog/import.js';
import { buildOpenLibraryAuthorIndex, buildOpenLibraryAuthorLookup } from '../scripts/catalog/open-library-bulk.js';
import { SnapshotRecordError } from '../scripts/catalog/snapshot-reader.js';
import { sealLanguageCheckedArtifact } from './catalog/language-check-helpers.js';

const ISBN = '9780141439518';
const OTHER_ISBN = '9780451524935';
const authorLookup = { async getNames(keys) { return new Map(keys.map(key => [key, key === '/authors/OL1A' ? 'Fixture Author' : 'Other Writer'])); } };
const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/catalog-bridge.js', import.meta.url));

function candidate(overrides = {}) {
  const signals = { ratingsCount: 5, ratingsSum: 20, readingLog: { 'Want to Read': 1, 'Currently Reading': 1, 'Already Read': 10 } };
  return { workKey: '/works/OL1W', title: 'Fixture Title', authorKeys: ['/authors/OL1A'], coverIds: [42], signals, score: popularityScore(signals), isbns: [ISBN], primaryAuthor: 'Fixture Author', ...overrides };
}

function sources(candidates = [candidate()], statuses = [], sealOptions = {}) {
  const artifact = sealLanguageCheckedArtifact({
    format: CATALOG_DISCOVER_FORMAT, version: CATALOG_DISCOVER_VERSION, snapshotId: 'fixture-snapshot', generatedAt: '2026-08-31T00:00:00.000Z',
    languageCheck: 'pending', scoring: { ...CATALOG_DISCOVER_SCORING },
    counts: { considered: candidates.length, eligible: candidates.length, selected: candidates.length, filteredByReason: Object.fromEntries(CATALOG_DISCOVER_FILTER_REASONS.map(reason => [reason, 0])) },
    candidates,
  }, sealOptions);
  const reportRows = candidates.map((value, index) => {
    const status = statuses[index] ?? 'new';
    return { workKey: value.workKey, title: value.title, status, matchedBookIds: status === 'new' ? [] : status === 'existing' ? ['id-a'] : ['id-a', 'id-b'], matchedBy: status === 'new' ? null : 'isbn', languageCheckDigest: artifact.languageCheckDigest };
  });
  return { artifact, reportRows };
}

function record(overrides = {}, key = '/books/OL1M') {
  return { type: '/type/edition', key, data: { key, title: 'Fixture Title', authors: [{ key: '/authors/OL1A' }], works: [{ key: '/works/OL1W' }], isbn_13: [ISBN], languages: [{ key: '/languages/eng' }], physical_format: 'paperback', covers: [7], subjects: ['Fantasy', 'Unknown genre'], publish_date: '2001', description: 'Edition description', ...overrides } };
}

async function bridge(input = sources(), records = [record()], options = {}) {
  return bridgeCatalogWorks({ ...input, records, authorLookup, ...options });
}

test('bridge selects a verified ISBN edition, maps real metadata, and feeds the existing importer without network or writes', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('No network'); };
  try {
    const result = await bridge();
    const entry = result.artifact.entries[0];
    assert.equal(entry.status, 'resolved');
    assert.deepEqual(entry.metadata, { isbn: ISBN, title: 'Fixture Title', author: 'Fixture Author', publicationYear: 2001, description: 'Edition description', coverImageUrl: 'https://covers.openlibrary.org/b/id/7-L.jpg?default=false', genres: [{ name: 'Fantasy', slug: 'fantasy' }] });
    assert.equal(entry.providerIds.openLibraryWork, '/works/OL1W');
    assert.equal(entry.providerIds.openLibraryEdition, '/books/OL1M');
    assert.deepEqual(validateImportArtifact(result.artifact), result.artifact);
    let reads = 0;
    const summary = await importResolvedCatalog({ book: { async findUnique({ where }) { assert.equal(where.isbn, ISBN); reads++; return null; } } }, result.artifact, { apply: false });
    assert.equal(reads, 1);
    assert.equal(summary.created, 1);
    assert.equal(summary.failed, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('bridge preserves existing, ambiguous, unknown-language, missing-author, missing-ISBN and limit exclusions', async () => {
  const candidates = [candidate(), ...[2, 3, 4, 5, 6, 7].map(id => candidate({ workKey: `/works/OL${id}W`, title: `Fixture Title ${id}` }))];
  candidates[3].languages = [];
  candidates[4].primaryAuthor = null;
  candidates[5].isbns = [];
  const input = sources(candidates, ['new', 'existing', 'ambiguous'], { keepUnknownLanguage: true });
  const result = await bridge(input, [record()], { limit: 1 });
  assert.deepEqual(result.artifact.entries.map(entry => entry.diagnostic?.code ?? entry.status), ['resolved', 'existing', 'ambiguous', 'unknown_language', 'missing_author', 'missing_isbn', 'limit']);
  const skipped = result.artifact.entries.filter(entry => entry.status !== 'resolved');
  const summary = await importResolvedCatalog({}, { ...result.artifact, entries: skipped }, { apply: true });
  assert.equal(summary.skipped, 6);
});

test('bridge requires English on the chosen edition and rejects unchecked ISBNs, wrong works and author mismatches', async () => {
  for (const edition of [record({ languages: [] }), record({ languages: [{ key: '/languages/fre' }] }), record({ isbn_13: [OTHER_ISBN] }), record({ works: [{ key: '/works/OL99W' }] }), record({ authors: [{ key: '/authors/OL2A' }] })]) {
    const result = await bridge(sources(), [edition]);
    assert.equal(result.summary.resolved, 0);
    assert.equal(result.artifact.entries[0].status, 'needs_review');
  }
});

test('bridge rejects non-book formats even when canonical normalization hides a qualifier', async () => {
  for (const format of ['audiobook', 'ebook', 'large print paperback', 'boxed set', 'wall calendar', 'blank journal', 'tarot deck', 'board game']) {
    const result = await bridge(sources(), [record({ physical_format: format })]);
    assert.equal(result.summary.resolved, 0, format);
  }
});

test('multiple ISBNs on one edition are one contender, ISBN-10 converts, and dump order does not choose a tied edition', async () => {
  const input = sources([candidate({ isbns: [ISBN, OTHER_ISBN].sort() })]);
  const multiple = await bridge(input, [record({ isbn_13: [OTHER_ISBN, ISBN] })]);
  assert.equal(multiple.artifact.entries[0].metadata.isbn, ISBN);
  const converted = await bridge(sources(), [record({ isbn_13: [], isbn_10: ['0141439513'] })]);
  assert.equal(converted.artifact.entries[0].metadata.isbn, ISBN);
  const records = [record(), record({ isbn_13: [OTHER_ISBN] }, '/books/OL2M')];
  const first = await bridge(input, records);
  const reversed = await bridge(input, [...records].reverse());
  assert.deepEqual(first.artifact, reversed.artifact);
  assert.equal(first.artifact.entries[0].diagnostic.code, 'ambiguous_winner');
});

test('bridge uses work covers only as optional fallback and does not invent publication years', async () => {
  const result = await bridge(sources(), [record({ covers: [], publish_date: 'circa 2001', first_publish_year: 1900, description: undefined, subjects: [] })]);
  const entry = result.artifact.entries[0];
  assert.equal(entry.metadata.publicationYear, null);
  assert.equal(entry.metadata.description, null);
  assert.deepEqual(entry.metadata.genres, []);
  assert.equal(entry.metadata.coverImageUrl, 'https://covers.openlibrary.org/b/id/42-L.jpg?default=false');
  assert.equal(entry.provenance.coverImageUrl, 'open_library_work');
});

test('invalid language seals and malformed, stale or contradictory dedup reports fail before edition or author reads', async () => {
  const changes = [
    value => { value.artifact.languageCheck = 'pending'; },
    value => { value.artifact.languageCheckDigest = '0'.repeat(64); },
    value => { delete value.reportRows[0].languageCheckDigest; },
    value => { value.reportRows[0].languageCheckDigest = '1'.repeat(64); },
    value => { value.reportRows[0].title = 'Wrong title'; },
    value => { value.reportRows.push(value.reportRows[0]); },
    value => { value.reportRows[0].matchedBookIds = ['existing-id']; },
    value => { value.reportRows[0].status = 'surprise'; },
  ];
  for (const change of changes) {
    const input = sources(); change(input);
    const records = { [Symbol.asyncIterator]() { throw new Error('must not scan'); } };
    await assert.rejects(bridge(input, records), error => error.name === 'CatalogContractError');
  }
});

test('malformed dump rows cannot resolve, operational failures and conflicting edition identities fail closed', async () => {
  const malformed = new SnapshotRecordError('Bad JSON');
  const result = await bridge(sources(), [malformed, record({ isbn_13: ['9780000000000'] })]);
  assert.equal(result.summary.resolved, 0);
  assert.equal(result.summary.malformedRows, 2);
  await assert.rejects(bridge(sources(), [record({ key: '/books/OL2M' })]), { code: 'invalid_edition_identity' });
  await assert.rejects(bridge(sources(), [record(), record({ description: 'Conflicting data' })]), { code: 'conflicting_edition' });
  await assert.rejects(bridge(sources(), [record()], { authorLookup: { async getNames() { throw new Error('disk read failed'); } } }), { code: 'author_lookup_error' });
  async function* broken() { yield record(); throw new Error('dump read failed'); }
  await assert.rejects(bridge(sources(), broken()), /dump read failed/);
});

test('duplicate resolved ISBNs fail validation and duplicate work identities are all held for review', async () => {
  const candidates = [candidate(), candidate({ workKey: '/works/OL2W', title: 'Another Title' })];
  const records = [record(), record({ title: 'Another Title', works: [{ key: '/works/OL2W' }] }, '/books/OL2M')];
  await assert.rejects(bridge(sources(candidates), records), { code: 'duplicate_resolved_isbn' });
  const sameWork = sources([candidate(), candidate({ workKey: '/works/OL2W', isbns: [OTHER_ISBN] })]);
  const result = await bridge(sameWork, [record(), record({ isbn_13: [OTHER_ISBN], works: [{ key: '/works/OL2W' }] }, '/books/OL2M')]);
  assert.deepEqual(result.artifact.entries.map(entry => entry.diagnostic.code), ['duplicate_work', 'duplicate_work']);
});

test('CLI writes an importable artifact offline; bad inputs preserve the previous output', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'bookish-bridge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const editionsPath = join(directory, 'editions.txt');
  const inputPath = join(directory, 'checked.json');
  const reportPath = join(directory, 'report.jsonl');
  const authorsPath = join(directory, 'authors.txt');
  const authorsIndexPath = join(directory, 'authors');
  const outputPath = join(directory, 'resolved.json');
  const edition = record();
  const line = `/type/edition\t${edition.key}\t1\t2026-08-31\t${JSON.stringify(edition.data)}\n`;
  await fs.writeFile(editionsPath, line);
  await fs.writeFile(authorsPath, '/type/author\t/authors/OL1A\t1\t2026-08-31\t{"name":"Fixture Author"}\n');
  await buildOpenLibraryAuthorIndex({ inputPath: authorsPath, outputPath: authorsIndexPath, snapshotId: 'fixture-snapshot' });
  await buildOpenLibraryAuthorLookup({ indexPath: authorsIndexPath, snapshotId: 'fixture-snapshot' });
  const input = sources([candidate()], [], { editionsBasename: 'editions.txt', editionsBytes: Buffer.byteLength(line) });
  await fs.writeFile(inputPath, JSON.stringify(input.artifact));
  await fs.writeFile(reportPath, input.reportRows.map(row => JSON.stringify(row)).join('\n'));
  const args = ['--experimental-sqlite', SCRIPT, '--input', inputPath, '--report', reportPath, '--editions', editionsPath, '--authors-index', authorsIndexPath, '--output', outputPath];
  const env = { ...process.env, DATABASE_URL: '', TEST_DATABASE_URL: '' };
  const result = await execFileAsync(process.execPath, args, { env });
  assert.equal(JSON.parse(result.stdout).resolved, 1);
  const original = await fs.readFile(outputPath, 'utf8');
  assert.equal(validateImportArtifact(JSON.parse(original)).entries[0].metadata.isbn, ISBN);
  const options = { inputPath, reportPath, editionsPath, authorsIndexPath, outputPath };
  await assert.rejects(runCatalogBridge({ ...options, outputPath: inputPath }), /overwrite an input/);
  await assert.rejects(runCatalogBridge({ ...options, outputPath: join(authorsIndexPath, 'index.json') }), /overwrite the author index/);
  await assert.rejects(runCatalogBridge({ ...options, limit: 0 }), /--limit/);
  const missingLookup = join(directory, 'missing-authors');
  await assert.rejects(runCatalogBridge({ ...options, authorsIndexPath: missingLookup }));
  await fs.writeFile(reportPath, '{bad json');
  await assert.rejects(runCatalogBridge(options), { code: 'invalid_dedup_report' });
  await fs.writeFile(reportPath, JSON.stringify(input.reportRows[0]));
  await fs.appendFile(editionsPath, '\n');
  await assert.rejects(runCatalogBridge(options), { code: 'snapshot_mismatch' });
  assert.equal(await fs.readFile(outputPath, 'utf8'), original);
  assert.deepEqual((await fs.readdir(directory)).filter(name => /\.(tmp|bak)$/.test(name)), []);
  for (const extra of [['--apply'], ['--limit', '1.5'], ['--output'], ['--limit', '1', '--limit', '2']]) {
    await assert.rejects(execFileAsync(process.execPath, ['--experimental-sqlite', SCRIPT, ...extra], { env }));
  }
});
