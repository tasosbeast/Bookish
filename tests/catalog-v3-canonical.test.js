import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogContractError, sourceFingerprint, validateSourceEntry } from '../scripts/catalog/contracts.js';
import {
  canonicalFieldProvenance,
  evaluateCanonicalIdentity,
  getCanonicalCandidates,
  mergeOptionalEnrichment,
  validateCanonicalCandidate,
  validateCanonicalFieldProvenance,
  validateOptionalEnrichment,
} from '../scripts/catalog/canonical-source.js';

const ISBN_A = '9780141439518';
const ISBN_B = '9780451524935';
const source = { key: 'pride-and-prejudice-jane-austen', title: 'Pride and Prejudice', author: 'Jane Austen', preferredIsbn13: ISBN_A };

function candidate(overrides = {}) {
  return {
    recordId: 'edition-1', snapshotId: 'snapshot-2026-09', sourceName: 'local-canonical', isbn13: ISBN_A,
    title: 'Pride and Prejudice', subtitle: null, authors: ['Jane Austen'], language: 'en', publisher: 'Penguin',
    publicationDate: '2003-01-01', publicationYear: 2003, format: 'Paperback',
    cover: { url: 'https://example.test/cover.jpg', reference: 'cover-1' }, description: 'A novel.', subjects: ['Fiction'],
    sourceIdentifiers: { localId: 'edition-1' }, ...overrides,
  };
}

test('canonical candidates validate required identity and snapshot fields', () => {
  const normalized = validateCanonicalCandidate(candidate());
  assert.equal(normalized.isbn13, ISBN_A);
  assert.equal(normalized.snapshotId, 'snapshot-2026-09');
  const nullableOptionalFields = validateCanonicalCandidate(candidate({ subjects: null, sourceIdentifiers: null }));
  assert.deepEqual(nullableOptionalFields.subjects, []);
  assert.deepEqual(nullableOptionalFields.sourceIdentifiers, {});
  assert.throws(() => validateCanonicalCandidate(candidate({ isbn13: '9780000000000' })), error => error instanceof CatalogContractError && error.code === 'invalid_canonical_isbn');
  assert.throws(() => validateCanonicalCandidate(candidate({ title: '' })), error => error instanceof CatalogContractError && error.code === 'malformed_canonical_value');
  assert.throws(() => validateCanonicalCandidate(candidate({ recordId: undefined })), error => error instanceof CatalogContractError && error.code === 'malformed_canonical_value');
});

test('canonical adapter is provider-independent and validates its local candidates', async () => {
  const received = [];
  const adapter = {
    sourceName: 'local-canonical',
    async getCandidates(entry) { received.push(entry); return [candidate()]; },
  };
  const candidates = await getCanonicalCandidates(adapter, source);
  assert.equal(candidates.length, 1);
  assert.equal(received[0].allowAlternateIsbn, false);

  const secondAdapter = { sourceName: 'local-canonical', getCandidates: async () => [candidate()] };
  assert.deepEqual(await getCanonicalCandidates(secondAdapter, source), candidates);
  await assert.rejects(
    getCanonicalCandidates({ sourceName: 'different', getCandidates: async () => [candidate()] }, source),
    error => error instanceof CatalogContractError && error.code === 'canonical_source_mismatch',
  );
});

test('alternate ISBN source policy is explicit and pinned identity remains absolute', () => {
  assert.equal(validateSourceEntry(source).allowAlternateIsbn, false);
  assert.notEqual(sourceFingerprint(source), sourceFingerprint({ ...source, allowAlternateIsbn: true }));
  assert.deepEqual(evaluateCanonicalIdentity(source, candidate({ isbn13: ISBN_B })), {
    status: 'needs_review', code: 'preferred_isbn_mismatch', expectedIsbn13: ISBN_A, candidateIsbn13: ISBN_B,
  });
  assert.equal(evaluateCanonicalIdentity({ ...source, allowAlternateIsbn: true }, candidate({ isbn13: ISBN_B })).status, 'eligible');
  assert.equal(evaluateCanonicalIdentity({ key: source.key, title: source.title, author: source.author }, candidate({ isbn13: ISBN_B })).status, 'eligible');
  assert.deepEqual(evaluateCanonicalIdentity({ ...source, pinnedIsbn13: ISBN_A }, candidate({ isbn13: ISBN_B })), {
    status: 'needs_review', code: 'pinned_isbn_mismatch', expectedIsbn13: ISBN_A, candidateIsbn13: ISBN_B,
  });
  assert.throws(
    () => validateSourceEntry({ ...source, pinnedIsbn13: ISBN_A, allowAlternateIsbn: true }),
    error => error instanceof CatalogContractError && error.code === 'pinned_alternate_isbn',
  );
});

test('field provenance is snapshot-based and source-neutral', () => {
  const provenance = canonicalFieldProvenance(candidate(), 'publicationDate', { enrichmentSource: 'cover-enrichment' });
  assert.deepEqual(validateCanonicalFieldProvenance(provenance), provenance);
  assert.equal(provenance.sourceName, 'local-canonical');
  assert.equal(provenance.snapshotId, 'snapshot-2026-09');
  assert.equal(provenance.recordId, 'edition-1');
});

test('optional enrichment can fill only missing optional metadata', () => {
  const incomplete = candidate({ cover: null, description: null, subjects: [] });
  const merged = mergeOptionalEnrichment(incomplete, {
    sourceName: 'optional-enrichment', cover: { url: 'https://example.test/enriched.jpg', reference: null },
    description: 'Enriched description.', subjects: ['Fiction'],
  });
  assert.equal(merged.metadata.isbn, ISBN_A);
  assert.equal(merged.metadata.title, 'Pride and Prejudice');
  assert.equal(merged.metadata.author, 'Jane Austen');
  assert.equal(merged.metadata.coverImageUrl, 'https://example.test/enriched.jpg');
  assert.equal(merged.provenance.coverImageUrl.enrichmentSource, 'optional-enrichment');
  assert.equal(merged.provenance.description.enrichmentSource, 'optional-enrichment');

  const preserved = mergeOptionalEnrichment(candidate(), {
    sourceName: 'optional-enrichment', cover: { url: 'https://example.test/wrong.jpg', reference: null },
    description: 'Wrong description.', subjects: ['Wrong'],
  });
  assert.equal(preserved.metadata.coverImageUrl, 'https://example.test/cover.jpg');
  assert.equal(preserved.metadata.description, 'A novel.');
  assert.deepEqual(preserved.metadata.subjects, ['Fiction']);
  assert.throws(
    () => validateOptionalEnrichment({ sourceName: 'optional-enrichment', isbn13: ISBN_B, cover: null, description: null, subjects: [] }),
    error => error instanceof CatalogContractError && error.code === 'unexpected_canonical_field',
  );
});
