import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCatalog } from '../scripts/catalog/resolve.js';
import { CatalogProviderError } from '../scripts/catalog/providers/errors.js';

const ISBN_A = '9780141439518';
const ISBN_B = '9780451524935';
const source = { key: 'pride-and-prejudice-jane-austen', title: 'Pride and Prejudice', author: 'Jane Austen' };

function work(sourceEntry = source, id = 'OL1W', overrides = {}) {
  return {
    provider: 'open_library', sourceType: 'work_search', providerIds: { workId: id, editionId: null }, title: sourceEntry.title,
    subtitle: null, authors: [sourceEntry.author], languages: ['eng'], isbn13: [], publishers: [], formats: [], publicationDates: [], publicationYears: [],
    coverImageUrls: [], descriptions: ['Open Library work description.'], subjects: ['Fiction'], ...overrides,
  };
}

function edition(sourceEntry = source, isbn = ISBN_A, id = 'OL1M', overrides = {}) {
  return {
    provider: 'open_library', sourceType: 'edition', providerIds: { workId: 'OL1W', editionId: id }, title: sourceEntry.title,
    subtitle: null, authors: [], languages: ['eng'], isbn13: [isbn], publishers: ['Penguin'], formats: ['Paperback'], publicationDates: ['2003'],
    publicationYears: [2003], coverImageUrls: ['https://covers.openlibrary.org/b/id/1-L.jpg?default=false'], descriptions: ['Edition description.'], subjects: ['Fiction'], ...overrides,
  };
}

function googleVolume(sourceEntry = source, isbn = ISBN_A, id = 'google-1', overrides = {}) {
  return {
    provider: 'google_books', sourceType: 'volume', providerIds: { volumeId: id }, title: sourceEntry.title,
    subtitle: null, authors: [sourceEntry.author], languages: ['en'], isbn13: [isbn], publishers: ['Google Books'], formats: ['BOOK'], publicationDates: ['2003'],
    publicationYears: [2003], coverImageUrls: ['https://books.google.com/books/content?id=1'], descriptions: ['Google Books description.'], subjects: ['Fiction'], ...overrides,
  };
}

function providers({ openWorks = [work()], openEditions = [edition()], googleVolumes = [], exactGoogle = null, errors = {} } = {}) {
  const calls = { openSearch: 0, openWork: 0, openEditions: 0, googleSearch: 0, googleExact: 0 };
  return {
    calls,
    clients: {
      openLibrary: {
        async searchWorks() { calls.openSearch++; if (errors.openSearch) throw errors.openSearch; return openWorks; },
        async fetchWork() { calls.openWork++; if (errors.openWork) throw errors.openWork; return openWorks[0] ?? null; },
        async fetchEditionsForWork() { calls.openEditions++; if (errors.openEditions) throw errors.openEditions; return openEditions; },
      },
      googleBooks: {
        async searchVolumes() { calls.googleSearch++; if (errors.googleSearch) throw errors.googleSearch; return googleVolumes; },
        async lookupByIsbn() { calls.googleExact++; if (errors.googleExact) throw errors.googleExact; return exactGoogle; },
      },
    },
  };
}

test('complete Open Library resolution does not call either Google Books operation', async () => {
  const configured = providers();
  const result = await resolveCatalog({ sources: [source], providers: configured.clients });

  assert.equal(result.artifact.entries[0].status, 'resolved');
  assert.deepEqual(configured.calls, { openSearch: 1, openWork: 1, openEditions: 1, googleSearch: 0, googleExact: 0 });
});

test('a preferred ISBN does not trigger Google when a complete safe Open Library edition is available', async () => {
  const preferred = { ...source, preferredIsbn13: ISBN_B };
  const configured = providers({ openWorks: [work(preferred)], openEditions: [edition(preferred, ISBN_A)] });
  const result = await resolveCatalog({ sources: [preferred], providers: configured.clients });

  assert.equal(result.artifact.entries[0].status, 'resolved');
  assert.equal(result.artifact.entries[0].metadata.isbn, ISBN_A);
  assert.equal(configured.calls.googleSearch, 0);
  assert.equal(configured.calls.googleExact, 0);
});

test('missing Open Library cover and description makes one exact Google enrichment call without a broad search', async () => {
  const configured = providers({
    openWorks: [work(source, 'OL1W', { descriptions: [] })],
    openEditions: [edition(source, ISBN_A, 'OL1M', { coverImageUrls: [], descriptions: [] })],
    exactGoogle: googleVolume(),
  });
  const result = await resolveCatalog({ sources: [source], providers: configured.clients });
  const entry = result.artifact.entries[0];

  assert.equal(entry.status, 'resolved');
  assert.equal(entry.metadata.coverImageUrl, 'https://books.google.com/books/content?id=1');
  assert.equal(entry.metadata.description, 'Google Books description.');
  assert.equal(configured.calls.googleSearch, 0);
  assert.equal(configured.calls.googleExact, 1);
});

test('no Open Library match uses Google Books search as the required fallback', async () => {
  const configured = providers({ openWorks: [], openEditions: [], googleVolumes: [googleVolume()] });
  const result = await resolveCatalog({ sources: [source], providers: configured.clients });

  assert.equal(result.artifact.entries[0].status, 'resolved');
  assert.equal(configured.calls.googleSearch, 1);
  assert.equal(configured.calls.googleExact, 0);
});

test('unusable Open Library editions use Google Books search as the required fallback', async () => {
  const configured = providers({ openEditions: [edition(source, ISBN_A, 'audio', { formats: ['Audiobook'] })], googleVolumes: [googleVolume()] });
  const result = await resolveCatalog({ sources: [source], providers: configured.clients });

  assert.equal(result.artifact.entries[0].status, 'resolved');
  assert.equal(configured.calls.googleSearch, 1);
  assert.equal(configured.calls.googleExact, 0);
});

test('a complete pinned Open Library edition makes no unnecessary Google request', async () => {
  const pinned = { ...source, preferredIsbn13: ISBN_A, pinnedIsbn13: ISBN_A };
  const configured = providers({ openWorks: [work(pinned)], openEditions: [edition(pinned)] });
  const result = await resolveCatalog({ sources: [pinned], providers: configured.clients });

  assert.equal(result.artifact.entries[0].status, 'resolved');
  assert.equal(configured.calls.googleSearch, 0);
  assert.equal(configured.calls.googleExact, 0);
});

test('a pinned Open Library mismatch tries exact Google ISBN evidence before review', async () => {
  const pinned = { ...source, preferredIsbn13: ISBN_B, pinnedIsbn13: ISBN_B };
  const configured = providers({ openWorks: [work(pinned)], openEditions: [edition(pinned, ISBN_A)], exactGoogle: null });
  const result = await resolveCatalog({ sources: [pinned], providers: configured.clients });

  assert.equal(result.artifact.entries[0].diagnostic.code, 'pinned_isbn_mismatch');
  assert.equal(configured.calls.googleExact, 1);
});

test('optional Google enrichment failure keeps a valid Open Library resolution', async () => {
  const rateLimited = new CatalogProviderError({ provider: 'google_books', stage: 'isbn_lookup', code: 'http_429', status: 429, retryable: true, attempts: 3, message: 'Rate limited' });
  const configured = providers({
    openWorks: [work(source, 'OL1W', { descriptions: [] })],
    openEditions: [edition(source, ISBN_A, 'OL1M', { coverImageUrls: [], descriptions: [] })],
    errors: { googleExact: rateLimited },
  });
  const result = await resolveCatalog({ sources: [source], providers: configured.clients });
  const entry = result.artifact.entries[0];

  assert.equal(entry.status, 'resolved');
  assert.equal(entry.metadata.coverImageUrl, null);
  assert.equal(entry.metadata.description, null);
  assert.ok(entry.selection.reasons.includes('google_books_optional_exact_isbn_failed'));
  assert.equal(configured.calls.googleSearch, 0);
  assert.equal(configured.calls.googleExact, 1);
});
