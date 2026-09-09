import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_ARTIFACT_VERSION,
  CATALOG_RESOLVER_VERSION,
  CatalogContractError,
  sourceFingerprint,
} from '../scripts/catalog/contracts.js';
import { importResolvedCatalog, validateImportArtifact } from '../scripts/catalog/import.js';

const first = { key: 'first-book-author', title: 'First Book', author: 'First Author' };
const second = { key: 'second-book-author', title: 'Second Book', author: 'Second Author' };
const ISBN_A = '9780141439518';
const ISBN_B = '9780451524935';

function resolvedEntry(source, isbn = ISBN_A) {
  return {
    key: source.key,
    sourceFingerprint: sourceFingerprint(source),
    resolverVersion: CATALOG_RESOLVER_VERSION,
    status: 'resolved',
    metadata: { title: source.title, author: source.author, isbn, publicationYear: null, description: null, coverImageUrl: null, genres: [] },
    providerIds: { openLibraryWork: null, openLibraryEdition: null, googleBooksVolume: null },
    provenance: { title: 'curated_source', author: 'curated_source', publicationYear: null, description: null, coverImageUrl: null, genres: null },
    selection: { score: 60, reasons: ['fixture'] },
    diagnostic: null,
  };
}

function artifact(entries) {
  return { artifactVersion: CATALOG_ARTIFACT_VERSION, resolverVersion: CATALOG_RESOLVER_VERSION, entries };
}

test('dry-run classifies resolved metadata without writes or network access', async () => {
  const calls = { reads: 0, transactions: 0 };
  const db = {
    book: { async findUnique() { calls.reads++; return null; } },
    async $transaction() { calls.transactions++; throw new Error('dry-run must not start a write transaction'); },
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network access is forbidden'); };
  try {
    const summary = await importResolvedCatalog(db, artifact([resolvedEntry(first)]), { apply: false });
    assert.deepEqual(summary, { created: 1, updated: 0, unchanged: 0, skipped: 0, failed: 0, resolved: 1 });
    assert.deepEqual(calls, { reads: 1, transactions: 0 });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('non-resolved artifact entries are skipped without database reads', async () => {
  const diagnostic = { provider: null, stage: 'resolution', code: 'fixture', message: 'Fixture', retryable: false, attempts: 0 };
  const entries = ['needs_review', 'failed'].map((status, index) => ({
    key: `${status.replace('_', '-')}-book-author`, sourceFingerprint: sourceFingerprint({ key: `${status.replace('_', '-')}-book-author`, title: `Book ${index}`, author: 'Author' }),
    resolverVersion: CATALOG_RESOLVER_VERSION, status, diagnostic,
  }));
  const db = { book: { async findUnique() { throw new Error('must not read'); } } };
  const summary = await importResolvedCatalog(db, artifact(entries), { apply: false });
  assert.deepEqual(summary, { created: 0, updated: 0, unchanged: 0, skipped: 2, failed: 0, resolved: 0 });
});

test('stale artifacts are rejected before database access', async () => {
  const value = artifact([resolvedEntry(first)]);
  value.entries[0].resolverVersion--;
  let transactions = 0;
  const db = { async $transaction() { transactions++; } };
  await assert.rejects(
    importResolvedCatalog(db, value, { apply: true }),
    error => error instanceof CatalogContractError && error.code === 'stale_artifact',
  );
  assert.equal(transactions, 0);
});

test('malformed and duplicate-ISBN artifacts are rejected before database access', async () => {
  let transactions = 0;
  const db = { async $transaction() { transactions++; } };
  await assert.rejects(importResolvedCatalog(db, { malformed: true }, { apply: true }), CatalogContractError);
  await assert.rejects(
    importResolvedCatalog(db, artifact([resolvedEntry(first), resolvedEntry(second, ISBN_A)]), { apply: true }),
    error => error instanceof CatalogContractError && error.code === 'duplicate_resolved_isbn',
  );
  assert.equal(transactions, 0);
  assert.doesNotThrow(() => validateImportArtifact(artifact([resolvedEntry(first), resolvedEntry(second, ISBN_B)])));
});

test('unsupported genres are rejected before database access', async () => {
  const value = artifact([resolvedEntry(first)]);
  value.entries[0].metadata.genres = [{ name: 'Noise', slug: 'noise' }];
  let transactions = 0;
  const db = { async $transaction() { transactions++; } };
  await assert.rejects(
    importResolvedCatalog(db, value, { apply: true }),
    error => error instanceof CatalogContractError && error.code === 'unsupported_genre',
  );
  assert.equal(transactions, 0);
});
