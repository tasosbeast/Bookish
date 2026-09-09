import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CATALOG_ARTIFACT_VERSION,
  CATALOG_RESOLVER_VERSION,
  sourceFingerprint,
} from '../scripts/catalog/contracts.js';
import { createCatalogStatus, formatCatalogStatus, isCatalogStatusStrictFailure } from '../scripts/catalog/status.js';

const execFileAsync = promisify(execFile);
const first = { key: 'first-book-author', title: 'First Book', author: 'First Author' };
const second = { key: 'second-book-author', title: 'Second Book', author: 'Second Author' };
const third = { key: 'third-book-author', title: 'Third Book', author: 'Third Author' };
const fourth = { key: 'fourth-book-author', title: 'Fourth Book', author: 'Fourth Author' };
const ISBN_A = '9780141439518';
const ISBN_B = '9780451524935';
const ISBN_C = '9780061120084';
const ISBN_D = '9780064407663';

function entry(source, status = 'resolved', { isbn = ISBN_A, fingerprint = sourceFingerprint(source), resolverVersion = CATALOG_RESOLVER_VERSION } = {}) {
  const common = {
    key: source.key,
    sourceFingerprint: fingerprint,
    resolverVersion,
    status,
  };
  if (status !== 'resolved') {
    return {
      ...common,
      diagnostic: { provider: 'open_library', stage: 'edition_selection', code: `${status}_fixture`, message: 'Fixture status', retryable: false, attempts: 1 },
    };
  }
  return {
    ...common,
    metadata: { title: source.title, author: source.author, isbn, publicationYear: 2001, description: null, coverImageUrl: null, genres: [] },
    providerIds: { openLibraryWork: null, openLibraryEdition: null, googleBooksVolume: null },
    provenance: { title: 'curated_source', author: 'curated_source', publicationYear: null, description: null, coverImageUrl: null, genres: null },
    selection: { score: 60, reasons: ['fixture'] },
    diagnostic: null,
  };
}

function artifact(entries, resolverVersion = CATALOG_RESOLVER_VERSION) {
  return { artifactVersion: CATALOG_ARTIFACT_VERSION, resolverVersion, entries };
}

async function temporaryFiles(run) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'bookish-catalog-status-'));
  try { await run(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('status classifies current resolved, review, failed, missing and orphaned entries', () => {
  const status = createCatalogStatus({
    sources: [first, second, third],
    artifact: artifact([entry(first), entry(second, 'needs_review'), entry({ key: 'orphan-book-author', title: 'Orphan', author: 'Author' }, 'resolved', { isbn: ISBN_B })]),
  });
  assert.equal(status.valid, true);
  assert.deepEqual(status.summary, {
    total: 3, resolved: 1, needs_review: 1, failed: 0, stale: 0, missing: 1, orphaned: 1,
    duplicateSourceIssues: [], duplicateResolvedIsbnIssues: [],
  });
  assert.equal(status.entries.needs_review[0].diagnostic.code, 'needs_review_fixture');
  assert.equal(status.entries.missing[0].key, third.key);
  assert.equal(status.orphaned[0].key, 'orphan-book-author');
});

test('status reports failed and every stale reason deterministically', () => {
  const status = createCatalogStatus({
    sources: [third, fourth, first, second],
    artifact: artifact([
      entry(first, 'failed'),
      entry(second, 'resolved', { resolverVersion: CATALOG_RESOLVER_VERSION - 1, isbn: ISBN_B }),
      entry(third, 'resolved', { fingerprint: sourceFingerprint({ ...third, title: 'Older title' }), isbn: ISBN_C }),
      entry(fourth, 'resolved', { fingerprint: sourceFingerprint({ ...fourth, title: 'Old revision' }), resolverVersion: CATALOG_RESOLVER_VERSION - 1, isbn: ISBN_D }),
    ]),
  });
  assert.equal(status.summary.failed, 1);
  assert.deepEqual(status.entries.stale.map(item => [item.key, item.staleReason]), [
    [fourth.key, 'both'],
    [second.key, 'resolver_version_mismatch'],
    [third.key, 'fingerprint_mismatch'],
  ]);
  assert.match(formatCatalogStatus(status), /both/);
});

test('status is offline when global fetch throws', () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network access is forbidden'); };
  try {
    const status = createCatalogStatus({ sources: [first], artifact: artifact([entry(first)]) });
    assert.equal(status.summary.resolved, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('status reports malformed source and artifact contracts including duplicate ISBN diagnostics', () => {
  const malformedSource = createCatalogStatus({ sources: {}, artifact: artifact([]) });
  assert.equal(malformedSource.valid, false);
  assert.equal(malformedSource.errors[0].scope, 'source');

  const invalidSource = createCatalogStatus({ sources: [{ ...first }, { ...first }], artifact: artifact([]) });
  assert.equal(invalidSource.valid, false);
  assert.equal(invalidSource.summary.duplicateSourceIssues[0].code, 'duplicate_key');

  const malformedArtifact = createCatalogStatus({ sources: [first], artifact: { malformed: true } });
  assert.equal(malformedArtifact.valid, false);
  assert.equal(malformedArtifact.errors[0].scope, 'artifact');

  const invalidArtifact = createCatalogStatus({ sources: [first, second], artifact: artifact([entry(first), entry(second, 'resolved', { isbn: ISBN_A })]) });
  assert.equal(invalidArtifact.valid, false);
  assert.equal(invalidArtifact.summary.duplicateResolvedIsbnIssues[0].code, 'duplicate_resolved_isbn');
});

test('strict mode only succeeds for a fully current resolved catalog', () => {
  const clean = createCatalogStatus({ sources: [first], artifact: artifact([entry(first)]) });
  const incomplete = createCatalogStatus({ sources: [first], artifact: null });
  assert.equal(isCatalogStatusStrictFailure(clean), false);
  assert.equal(isCatalogStatusStrictFailure(incomplete), true);
});

test('CLI emits deterministic JSON and enforces strict mode offline', async () => {
  await temporaryFiles(async directory => {
    const sourcePath = join(directory, 'source.json');
    const artifactPath = join(directory, 'artifact.json');
    await fs.writeFile(sourcePath, JSON.stringify([second, first]), 'utf8');
    await fs.writeFile(artifactPath, JSON.stringify(artifact([entry(first), entry(second, 'failed', { isbn: ISBN_B })])), 'utf8');
    const script = join(process.cwd(), 'scripts', 'catalog-status.js');
    const result = await execFileAsync(process.execPath, [script, '--source', sourcePath, '--artifact', artifactPath, '--json']);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.summary.total, 2);
    assert.ok(Array.isArray(parsed.orphaned));
    assert.deepEqual(parsed.entries.failed.map(item => item.key), [second.key]);
    await assert.rejects(
      execFileAsync(process.execPath, [script, '--source', sourcePath, '--artifact', artifactPath, '--json', '--strict']),
      error => error.code === 1 && JSON.parse(error.stdout).summary.failed === 1,
    );

    await fs.writeFile(artifactPath, JSON.stringify(artifact([entry(first), entry(second, 'resolved', { isbn: ISBN_B })])), 'utf8');
    const strictSuccess = await execFileAsync(process.execPath, [script, '--source', sourcePath, '--artifact', artifactPath, '--strict']);
    assert.match(strictSuccess.stdout, /resolved: 2/);
  });
});
