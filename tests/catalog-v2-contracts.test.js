import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_ARTIFACT_VERSION,
  CATALOG_RESOLVER_VERSION,
  CatalogContractError,
  detectSourceDuplicates,
  sourceFingerprint,
  validateResolvedArtifact,
  validateResolvedEntry,
  validateSourceEntry,
  validateSourceManifest,
} from '../scripts/catalog/contracts.js';
import { normalizeAuthorName, normalizeIsbn13, normalizeStableKey, normalizeTitle } from '../scripts/catalog/normalize.js';

const source = { key: 'pride-and-prejudice-jane-austen', title: 'Pride and Prejudice', author: 'Jane Austen', preferredIsbn13: '978-0-14-143951-8' };
const fingerprint = sourceFingerprint(source);
const diagnostic = { provider: 'open_library', stage: 'edition', code: 'not_found', message: 'Edition was not found', retryable: false, attempts: 1 };
const resolved = {
  key: source.key, sourceFingerprint: fingerprint, resolverVersion: CATALOG_RESOLVER_VERSION, status: 'resolved',
  metadata: { title: source.title, author: source.author, isbn: '9780141439518', publicationYear: 2003, description: null, coverImageUrl: 'https://covers.openlibrary.org/b/id/1-L.jpg?default=false', genres: [{ name: 'Fiction', slug: 'fiction' }] },
  providerIds: { openLibraryWork: 'OL66554W', openLibraryEdition: 'OL7353617M', googleBooksVolume: null },
  provenance: { title: 'source', author: 'source', publicationYear: 'open_library_edition', description: null, coverImageUrl: 'open_library_edition', genres: 'open_library_work' },
  selection: { score: 90, reasons: ['title_exact', 'author_exact'] }, diagnostic: null,
};

test('v2 source contract accepts canonical entries and checks ISBN-13', () => {
  assert.deepEqual(validateSourceEntry(source), { ...source, preferredIsbn13: '9780141439518' });
  assert.equal(normalizeIsbn13('978-0-14-143951-8'), '9780141439518');
  for (const value of ['9780141439519', null, 9780141439518]) assert.throws(() => validateSourceEntry({ ...source, preferredIsbn13: value }));
});

test('v2 source contract rejects malformed and unexpected values', () => {
  for (const entry of [{ ...source, key: 'Not stable' }, { ...source, title: ' ' }, { ...source, author: [] }, { ...source, unknown: true }, null]) assert.throws(() => validateSourceEntry(entry));
  assert.throws(() => validateSourceManifest({ entries: [source] }));
});

test('v2 fingerprints are deterministic and track curated display fields', () => {
  assert.equal(fingerprint, sourceFingerprint({ author: 'Jane Austen', preferredIsbn13: '9780141439518', title: 'Pride and Prejudice', key: source.key }));
  assert.equal(fingerprint, sourceFingerprint({ ...source, title: '  Pride and Prejudice  ' }));
  assert.notEqual(fingerprint, sourceFingerprint({ ...source, title: 'Pride & Prejudice' }));
  assert.notEqual(fingerprint, sourceFingerprint({ ...source, title: 'pride and prejudice' }));
  assert.notEqual(fingerprint, sourceFingerprint({ ...source, author: 'JANE AUSTEN' }));
  const { preferredIsbn13, ...withoutPreference } = source;
  assert.notEqual(fingerprint, sourceFingerprint(withoutPreference));
});

test('v2 normalization is deterministic and display-independent', () => {
  assert.equal(normalizeTitle('The  Café—Society!'), 'cafe society');
  assert.equal(normalizeAuthorName('Austen, Jane'), 'jane austen');
  assert.equal(normalizeStableKey('Pride & Prejudice / Jane Austen'), 'pride-prejudice-jane-austen');
});

test('v2 duplicate detection finds keys, ISBN preferences and normalized works', () => {
  const second = { key: 'another-key', title: 'The Pride and Prejudice', author: 'Austen, Jane', preferredIsbn13: '9780141439518' };
  const duplicates = detectSourceDuplicates([source, second, { ...source }]);
  assert.equal(duplicates.keys.length, 1);
  assert.equal(duplicates.preferredIsbn13.length, 1);
  assert.equal(duplicates.works.length, 1);
  assert.throws(() => validateSourceManifest([source, second]), /Duplicate preferred ISBN/);
  const { preferredIsbn13: sourceIsbn, ...withoutSourceIsbn } = source;
  const { preferredIsbn13: secondIsbn, ...withoutSecondIsbn } = second;
  assert.throws(() => validateSourceManifest([withoutSourceIsbn, withoutSecondIsbn]), /Duplicate normalized work/);
});

test('v2 resolved artifact contract accepts resolved entries and rejects invalid metadata', () => {
  assert.deepEqual(validateResolvedEntry(resolved), resolved);
  assert.deepEqual(validateResolvedArtifact({ artifactVersion: CATALOG_ARTIFACT_VERSION, resolverVersion: CATALOG_RESOLVER_VERSION, entries: [resolved] }).entries, [resolved]);
  assert.throws(() => validateResolvedEntry({ ...resolved, metadata: { ...resolved.metadata, isbn: 'bad' } }));
  assert.throws(() => validateResolvedEntry({ ...resolved, metadata: { ...resolved.metadata, coverImageUrl: 'http://example.test/cover.jpg' } }));
});

test('v2 non-resolved artifact entries require diagnostics and no importable metadata', () => {
  for (const status of ['needs_review', 'failed']) {
    const entry = { key: source.key, sourceFingerprint: fingerprint, resolverVersion: CATALOG_RESOLVER_VERSION, status, diagnostic };
    assert.equal(validateResolvedEntry(entry).status, status);
    assert.throws(() => validateResolvedEntry({ ...entry, metadata: resolved.metadata }));
    assert.throws(() => validateResolvedEntry({ ...entry, diagnostic: { ...diagnostic, attempts: -1 } }));
  }
});

test('v2 resolved artifact rejects duplicate resolved ISBNs only', () => {
  const artifact = entries => ({ artifactVersion: CATALOG_ARTIFACT_VERSION, resolverVersion: CATALOG_RESOLVER_VERSION, entries });
  const otherResolved = { ...resolved, key: 'sense-and-sensibility-jane-austen' };

  assert.throws(
    () => validateResolvedArtifact(artifact([resolved, otherResolved])),
    error => error instanceof CatalogContractError && error.code === 'duplicate_resolved_isbn',
  );

  const nonResolvedEntries = ['needs_review', 'failed'].map((status, index) => ({
    key: `unresolved-book-${index}`,
    sourceFingerprint: fingerprint,
    resolverVersion: CATALOG_RESOLVER_VERSION,
    status,
    diagnostic,
  }));
  assert.doesNotThrow(() => validateResolvedArtifact(artifact([resolved, ...nonResolvedEntries])));

  const distinctResolved = {
    ...otherResolved,
    metadata: { ...resolved.metadata, isbn: '9780451524935' },
  };
  assert.doesNotThrow(() => validateResolvedArtifact(artifact([resolved, distinctResolved])));
});
