import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { CatalogContractError } from '../scripts/catalog/contracts.js';
import {
  createReadOnlyDbInterface,
  loadDiscoverCandidates,
  runCatalogDedupCheck,
} from '../scripts/catalog/dedup-check.js';
import {
  CATALOG_DISCOVER_FORMAT,
  CATALOG_DISCOVER_SCORING,
  CATALOG_DISCOVER_VERSION,
  popularityScore,
} from '../scripts/catalog/discover.js';
import { enrichCatalogCandidates } from '../scripts/catalog/enrich.js';
import { importCatalogWorks } from '../scripts/catalog/import.js';
import {
  checkCatalogLanguages,
  languageCheckDigestForArtifact,
  validateLanguageCheckedArtifact,
  writeLanguageCheckedArtifactAtomically,
} from '../scripts/catalog/language-check.js';
import { buildOpenLibraryAuthorIndex, buildOpenLibraryAuthorLookup } from '../scripts/catalog/open-library-bulk.js';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/catalog-language-check.js', import.meta.url));
const SNAPSHOT_ID = 'fixture-snapshot';
const GENERATED_AT = '2026-08-31T00:00:00.000Z';

function discoverCandidate(overrides = {}) {
  const signals = {
    ratingsCount: 5,
    ratingsSum: 20,
    readingLog: { 'Want to Read': 1, 'Currently Reading': 1, 'Already Read': 10 },
    ...(overrides.signals ?? {}),
  };
  const { signals: _signals, score: scoreOverride, isbns, primaryAuthor, ...rest } = overrides;
  return {
    workKey: '/works/OL100W',
    title: 'Fixture Title',
    authorKeys: ['/authors/OL1A'],
    coverIds: [1],
    score: scoreOverride ?? popularityScore(signals),
    signals,
    isbns: isbns ?? [],
    primaryAuthor: primaryAuthor === undefined ? 'Fixture Author' : primaryAuthor,
    ...rest,
  };
}

function byRank(left, right) {
  return right.score - left.score || (left.workKey < right.workKey ? -1 : left.workKey > right.workKey ? 1 : 0);
}

function enrichedArtifact(candidates, snapshotId = SNAPSHOT_ID) {
  const sorted = [...candidates].sort(byRank);
  return {
    format: CATALOG_DISCOVER_FORMAT,
    version: CATALOG_DISCOVER_VERSION,
    snapshotId,
    generatedAt: GENERATED_AT,
    languageCheck: 'pending',
    scoring: { ...CATALOG_DISCOVER_SCORING },
    counts: {
      considered: sorted.length,
      filteredByReason: {
        invalid_work_key: 0,
        missing_title: 0,
        missing_cover: 0,
        excluded: 0,
        no_signal: 0,
        below_min_ratings: 0,
        below_min_readers: 0,
      },
      eligible: sorted.length,
      selected: sorted.length,
    },
    candidates: sorted,
  };
}

function editionLine(key, data) {
  return `/type/edition\t${key}\t1\t2026-01-01T00:00:00.000000\t${JSON.stringify(data)}\n`;
}

function authorLine(key, name) {
  return `/type/author\t${key}\t1\t2026-01-01T00:00:00.000000\t${JSON.stringify({ name })}\n`;
}

async function temporaryDirectory() {
  return fs.mkdtemp(join(tmpdir(), 'bookish-language-check-'));
}

async function writeGzip(path, text) {
  await fs.writeFile(path, gzipSync(Buffer.from(text)));
}

function classificationCandidates() {
  return [
    discoverCandidate({ workKey: '/works/OL100W', title: 'English Novel' }),
    discoverCandidate({ workKey: '/works/OL200W', title: 'French Novel' }),
    discoverCandidate({ workKey: '/works/OL300W', title: 'Mixed Novel' }),
    discoverCandidate({ workKey: '/works/OL400W', title: 'No Language' }),
    discoverCandidate({ workKey: '/works/OL500W', title: 'No Edition' }),
  ];
}

function classificationEditions() {
  return [
    editionLine('/books/OL1M', {
      works: [{ key: '/works/OL100W' }],
      languages: [{ key: '/languages/eng' }],
    }),
    editionLine('/books/OL1BM', {
      works: [{ key: '/works/OL100W' }],
      languages: ['eng'],
    }),
    editionLine('/books/OL2M', {
      works: [{ key: '/works/OL200W' }],
      languages: [{ key: '/languages/fre' }],
    }),
    editionLine('/books/OL2BM', {
      works: [{ key: '/works/OL200W' }],
      languages: [{ key: '/languages/spa' }],
    }),
    editionLine('/books/OL3M', {
      works: [{ key: '/works/OL300W' }],
      languages: [{ key: '/languages/ger' }],
    }),
    editionLine('/books/OL3BM', {
      works: [{ key: '/works/OL300W' }],
      languages: [{ key: '/languages/ENG' }],
    }),
    editionLine('/books/OL4M', {
      works: [{ key: '/works/OL400W' }],
      languages: [],
    }),
    editionLine('/books/OL9M', {
      works: [{ key: '/works/OL999W' }],
      languages: [{ key: '/languages/eng' }],
    }),
    '/type/edition\t/books/OLBROKENM\t1\t2026-01-01T00:00:00.000000\t{not-json}\n',
    '/type/work\t/works/OL100W\t1\t2026-01-01T00:00:00.000000\t{"title":"Ignored"}\n',
  ].join('');
}

async function writeClassificationFixture(directory) {
  const inputPath = join(directory, 'enriched.json');
  const editionsPath = join(directory, 'ol_dump_editions_fixture.txt.gz');
  await fs.writeFile(inputPath, `${JSON.stringify(enrichedArtifact(classificationCandidates()))}\n`);
  await writeGzip(editionsPath, classificationEditions());
  return { inputPath, editionsPath };
}

function reportRows(candidates) {
  return candidates.map(candidate => ({
    workKey: candidate.workKey,
    title: candidate.title,
    status: 'new',
    matchedBookIds: [],
    matchedBy: null,
  }));
}

function applyDb() {
  const stored = [];
  const book = {
    async findMany({ where } = {}) {
      if (where?.openLibraryWorkKey?.in) {
        return stored.filter(row => where.openLibraryWorkKey.in.includes(row.openLibraryWorkKey));
      }
      if (!where?.OR) return stored;
      return stored.filter(row => where.OR.some(clause => (
        clause.openLibraryWorkKey?.in?.includes(row.openLibraryWorkKey)
        || (clause.isbn?.in && row.isbn && clause.isbn.in.includes(row.isbn))
      )));
    },
    async createMany({ data }) {
      stored.push(...data);
      return { count: data.length };
    },
  };
  return { book, $transaction: async work => work({ book }) };
}

test('language check keeps English and mixed works and drops the rest', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { inputPath, editionsPath } = await writeClassificationFixture(directory);
  const outputPath = join(directory, 'checked.json');
  const result = await checkCatalogLanguages({ inputPath, editionsPath, outputPath });

  assert.equal(result.languageCheck, 'passed');
  assert.equal(result.snapshotId, SNAPSHOT_ID);
  assert.equal(result.rowsScanned, 10);
  assert.equal(result.matchedEditions, 7);
  assert.equal(result.malformedRows, 1);
  assert.equal(result.kept, 2);
  assert.equal(result.droppedNonEnglish, 1);
  assert.equal(result.droppedUnknownLanguage, 2);
  assert.equal(result.keptUnknownLanguage, 0);
  assert.deepEqual(result.droppedByReason, { non_english: 1, unknown_language: 2 });
  assert.deepEqual(result.artifact.candidates.map(candidate => candidate.workKey), ['/works/OL100W', '/works/OL300W']);
  assert.deepEqual(result.artifact.candidates[0].languages, ['/languages/eng']);
  assert.deepEqual(result.artifact.candidates[1].languages, ['/languages/eng', '/languages/ger']);
  assert.equal(result.artifact.languageCheck, 'passed');
  assert.equal(result.artifact.counts.selected, 2);
  assert.equal(result.languageCheckDigest, languageCheckDigestForArtifact(result.artifact));
  assert.equal(result.editionsBasename, 'ol_dump_editions_fixture.txt.gz');
  assert.equal(result.editionsBytes, (await fs.stat(editionsPath)).size);
  const written = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  validateLanguageCheckedArtifact(written, { snapshotId: SNAPSHOT_ID });
  const loaded = await loadDiscoverCandidates(outputPath);
  assert.deepEqual(loaded.map(candidate => candidate.workKey), ['/works/OL100W', '/works/OL300W']);
  const reversed = { ...written, candidates: [...written.candidates].reverse() };
  assert.equal(languageCheckDigestForArtifact(reversed), written.languageCheckDigest);
  const resized = {
    ...written,
    languageCheckEditions: { ...written.languageCheckEditions, bytes: written.languageCheckEditions.bytes + 1 },
  };
  assert.notEqual(languageCheckDigestForArtifact(resized), written.languageCheckDigest);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.includes('.tmp') || name.includes('.bak')), []);
});

test('--keep-unknown-language keeps works with no language data and still drops non-English works', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { inputPath, editionsPath } = await writeClassificationFixture(directory);
  const outputPath = join(directory, 'checked.json');
  const result = await checkCatalogLanguages({
    inputPath,
    editionsPath,
    outputPath,
    keepUnknownLanguage: true,
  });
  assert.deepEqual(result.artifact.candidates.map(candidate => [candidate.workKey, candidate.languages]), [
    ['/works/OL100W', ['/languages/eng']],
    ['/works/OL300W', ['/languages/eng', '/languages/ger']],
    ['/works/OL400W', []],
    ['/works/OL500W', []],
  ]);
  assert.equal(result.droppedNonEnglish, 1);
  assert.equal(result.droppedUnknownLanguage, 0);
  assert.equal(result.keptUnknownLanguage, 2);
  assert.equal(result.artifact.counts.selected, 4);
  validateLanguageCheckedArtifact(result.artifact, { snapshotId: SNAPSHOT_ID });
});

test('a snapshot mismatch leaves the previous output in place', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { inputPath, editionsPath } = await writeClassificationFixture(directory);
  const outputPath = join(directory, 'checked.json');
  const previous = '{"keep":"previous"}\n';
  await fs.writeFile(outputPath, previous);
  await assert.rejects(
    () => checkCatalogLanguages({
      inputPath,
      editionsPath,
      outputPath,
      snapshotId: 'other-snapshot',
    }),
    error => error instanceof CatalogContractError
      && error.code === 'snapshot_mismatch'
      && error.message.includes('does not match the enriched artifact snapshot fixture-snapshot'),
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), previous);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.includes('.tmp') || name.includes('.bak')), []);
});

test('writeLanguageCheckedArtifactAtomically keeps the previous file when validation fails', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { inputPath, editionsPath } = await writeClassificationFixture(directory);
  const outputPath = join(directory, 'checked.json');
  const result = await checkCatalogLanguages({ inputPath, editionsPath, outputPath });
  const before = await fs.readFile(outputPath, 'utf8');
  const bad = {
    ...result.artifact,
    languageCheckDigest: result.languageCheckDigest.replace(/^./, result.languageCheckDigest.startsWith('a') ? 'b' : 'a'),
  };
  await assert.rejects(
    () => writeLanguageCheckedArtifactAtomically(outputPath, bad, { snapshotId: SNAPSHOT_ID }),
    error => error instanceof CatalogContractError && error.code === 'invalid_language_check',
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), before);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.includes('.tmp') || name.includes('.bak')), []);
});

test('import apply accepts a real language check and refuses a tampered languageCheck or digest', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { inputPath, editionsPath } = await writeClassificationFixture(directory);
  const outputPath = join(directory, 'checked.json');
  const { artifact } = await checkCatalogLanguages({ inputPath, editionsPath, outputPath });
  const rows = reportRows(artifact.candidates);
  const applied = await importCatalogWorks({
    db: applyDb(),
    reportRows: rows,
    artifact,
    apply: true,
    limit: 10,
    batchSize: 10,
  });
  assert.equal(applied.summary.languageCheck, 'passed');
  assert.equal(applied.summary.inserted, 2);
  assert.equal(applied.exitCode, 0);

  let calls = 0;
  const guarded = {
    book: { findMany: async () => { calls += 1; return []; } },
    $transaction: async () => { calls += 1; },
  };
  await assert.rejects(
    () => importCatalogWorks({
      db: guarded,
      reportRows: rows,
      artifact: { ...artifact, languageCheck: 'pending' },
      apply: true,
    }),
    error => error instanceof Error
      && error.message.includes('Refusing --apply')
      && error.message.includes('not "passed"'),
  );
  const tamperedDigest = `${artifact.languageCheckDigest.slice(0, -1)}${artifact.languageCheckDigest.endsWith('a') ? 'b' : 'a'}`;
  await assert.rejects(
    () => importCatalogWorks({
      db: guarded,
      reportRows: rows,
      artifact: { ...artifact, languageCheckDigest: tamperedDigest },
      apply: true,
    }),
    error => error instanceof Error
      && error.message.includes('Refusing --apply')
      && error.message.includes('languageCheckDigest'),
  );
  const edited = structuredClone(artifact);
  edited.candidates[0].languages = ['/languages/fre'];
  await assert.rejects(
    () => importCatalogWorks({
      db: guarded,
      reportRows: rows,
      artifact: edited,
      apply: true,
    }),
    error => error instanceof Error && error.message.includes('languageCheckDigest'),
  );
  assert.equal(calls, 0);

  const warnings = [];
  const original = console.error;
  console.error = (...parts) => { warnings.push(parts.map(String).join(' ')); };
  try {
    const overridden = await importCatalogWorks({
      db: applyDb(),
      reportRows: rows,
      artifact: { ...artifact, languageCheckDigest: tamperedDigest },
      apply: true,
      allowUncheckedLanguage: true,
      limit: 10,
      batchSize: 10,
    });
    assert.equal(overridden.summary.inserted, 2);
  } finally {
    console.error = original;
  }
  assert.match(warnings.join('\n'), /WARNING: --allow-unchecked-language/);
});

test('enrich, language-check, dedup-check, and import dry-run keep the English work', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const discoverPath = join(directory, 'discover.json');
  const editionsPath = join(directory, 'ol_dump_editions_fixture.txt.gz');
  const enrichedPath = join(directory, 'enriched.json');
  const checkedPath = join(directory, 'checked.json');
  const reportPath = join(directory, 'dedup.jsonl');
  const discoverCandidates = [
    ['/works/OL100W', 'Pride and Prejudice'],
    ['/works/OL200W', 'Orgueil et Prejuges'],
  ].map(([workKey, title]) => {
    const candidate = discoverCandidate({ workKey, title });
    const { isbns: _isbns, primaryAuthor: _primaryAuthor, ...core } = candidate;
    return core;
  });
  await fs.writeFile(discoverPath, `${JSON.stringify(enrichedArtifact(discoverCandidates))}\n`);
  await writeGzip(editionsPath, [
    editionLine('/books/OL1M', {
      works: [{ key: '/works/OL100W' }],
      languages: [{ key: '/languages/eng' }],
      isbn_10: ['0141439513'],
    }),
    editionLine('/books/OL2M', {
      works: [{ key: '/works/OL200W' }],
      languages: [{ key: '/languages/fre' }],
      isbn_13: ['9782070413119'],
    }),
  ].join(''));
  const authorsPath = join(directory, 'authors.txt');
  const authorsIndexPath = join(directory, 'authors-index');
  await fs.writeFile(authorsPath, authorLine('/authors/OL1A', 'Jane Austen'));
  await buildOpenLibraryAuthorIndex({
    inputPath: authorsPath,
    outputPath: authorsIndexPath,
    snapshotId: SNAPSHOT_ID,
    generatedAt: GENERATED_AT,
  });
  await buildOpenLibraryAuthorLookup({ indexPath: authorsIndexPath, snapshotId: SNAPSHOT_ID, batchSize: 1 });
  const enriched = await enrichCatalogCandidates({
    inputPath: discoverPath,
    editionsPath,
    authorsIndexPath,
    outputPath: enrichedPath,
  });
  assert.equal(enriched.artifact.candidates.length, 2);
  assert.equal(enriched.artifact.candidates[0].primaryAuthor, 'Jane Austen');
  assert.deepEqual(enriched.artifact.candidates[0].isbns, ['9780141439518']);

  const checked = await checkCatalogLanguages({
    inputPath: enrichedPath,
    editionsPath,
    outputPath: checkedPath,
  });
  assert.deepEqual(checked.artifact.candidates.map(candidate => candidate.workKey), ['/works/OL100W']);
  assert.deepEqual(checked.artifact.candidates[0].languages, ['/languages/eng']);
  assert.equal(checked.artifact.candidates[0].primaryAuthor, 'Jane Austen');
  assert.deepEqual(checked.artifact.candidates[0].isbns, ['9780141439518']);

  const readOnly = createReadOnlyDbInterface({
    book: { findMany: async () => [] },
    $disconnect: async () => {},
  });
  const dedup = await runCatalogDedupCheck({ db: readOnly, inputPath: checkedPath, outputPath: reportPath });
  assert.deepEqual(dedup.summary, { new: 1, existing: 0, ambiguous: 0 });
  assert.equal(dedup.results[0].workKey, '/works/OL100W');
  assert.equal(dedup.results[0].status, 'new');

  const imported = await importCatalogWorks({
    db: { book: { findMany: async () => [] } },
    reportRows: dedup.results,
    artifact: checked.artifact,
    apply: false,
    limit: 10,
    batchSize: 10,
  });
  assert.equal(imported.summary.mode, 'dry-run');
  assert.equal(imported.summary.languageCheck, 'passed');
  assert.equal(imported.summary.planned, 1);
  assert.equal(imported.summary.inserted, 0);
  assert.equal(imported.rows[0].action, 'plan');
  assert.equal(imported.rows[0].workKey, '/works/OL100W');
});

test('catalog:language-check CLI writes the checked artifact and rejects a bad snapshot', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    () => execFileAsync(process.execPath, [SCRIPT, '--not-a-flag']),
    error => error.code === 1 && error.stderr.includes('Unknown argument --not-a-flag'),
  );
  const { inputPath, editionsPath } = await writeClassificationFixture(directory);
  const outputPath = join(directory, 'checked.json');
  const { stdout } = await execFileAsync(process.execPath, [
    SCRIPT,
    '--input', inputPath,
    '--editions', editionsPath,
    '--output', outputPath,
    '--snapshot-id', SNAPSHOT_ID,
  ], { env: { PATH: process.env.PATH } });
  const summary = JSON.parse(stdout);
  assert.equal(summary.languageCheck, 'passed');
  assert.equal(summary.kept, 2);
  assert.equal(summary.droppedByReason.non_english, 1);
  assert.equal(summary.droppedByReason.unknown_language, 2);
  const written = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  assert.equal(written.languageCheck, 'passed');
  const previous = await fs.readFile(outputPath, 'utf8');
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      SCRIPT,
      '--input', inputPath,
      '--editions', editionsPath,
      '--output', outputPath,
      '--snapshot-id', 'other-snapshot',
    ], { env: { PATH: process.env.PATH } }),
    error => error.code === 1 && error.stderr.includes('does not match the enriched artifact snapshot'),
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), previous);
});

test('a corrupt editions gzip is reported and leaves the previous output', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, 'enriched.json');
  const editionsPath = join(directory, 'ol_dump_editions_fixture.txt.gz');
  const outputPath = join(directory, 'checked.json');
  await fs.writeFile(inputPath, `${JSON.stringify(enrichedArtifact(classificationCandidates()))}\n`);
  await fs.writeFile(editionsPath, Buffer.from('not gzip'));
  const previous = '{"keep":"previous"}\n';
  await fs.writeFile(outputPath, previous);
  await assert.rejects(
    () => checkCatalogLanguages({ inputPath, editionsPath, outputPath }),
    error => error instanceof Error && !/unhandled/i.test(error.message),
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), previous);
});

test('language-check source does not reference Prisma, the database URL, fetch, or dotenv', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['catalog:language-check'], 'node scripts/catalog-language-check.js');
  const moduleSource = await fs.readFile(new URL('../scripts/catalog/language-check.js', import.meta.url), 'utf8');
  const cliSource = await fs.readFile(new URL('../scripts/catalog-language-check.js', import.meta.url), 'utf8');
  for (const source of [moduleSource, cliSource]) {
    assert.equal(source.includes('prisma'), false);
    assert.equal(source.includes('DATABASE_URL'), false);
    assert.equal(source.includes('fetch('), false);
    assert.equal(source.includes('dotenv'), false);
  }
});
