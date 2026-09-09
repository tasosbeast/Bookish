import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleBooksClient } from '../scripts/catalog/providers/google-books.js';
import { createOpenLibraryClient } from '../scripts/catalog/providers/open-library.js';
import { CatalogProviderError, MAX_RETRY_AFTER_MS, requestProvider, retryAfterMs } from '../scripts/catalog/providers/errors.js';

const isbn = '9780141439518';
const openEdition = {
  title: 'Pride and Prejudice', subtitle: 'A Novel', isbn_13: [isbn], authors: [{ key: '/authors/OL1A', name: 'Jane Austen' }],
  languages: [{ key: '/languages/eng' }], publishers: ['Penguin Classics'], physical_format: 'Paperback', publish_date: '2003',
  covers: [123], description: { value: 'A classic novel.' }, subjects: ['Fiction'], works: [{ key: '/works/OL66554W' }],
};
const googleVolume = {
  id: 'volume-1',
  volumeInfo: {
    title: 'Pride and Prejudice', subtitle: 'A Novel', authors: ['Jane Austen'], language: 'en', publisher: 'Penguin Classics', publishedDate: '2003-01-01',
    industryIdentifiers: [{ type: 'ISBN_13', identifier: isbn }], categories: ['Fiction'], description: 'A classic novel.', printType: 'BOOK',
    imageLinks: { large: 'http://books.google.com/books/content?id=volume-1' },
  },
};

function expectProviderError(check) {
  return error => error instanceof CatalogProviderError && check(error);
}

test('Open Library searches title and author and normalizes work candidates', async () => {
  const calls = [];
  const client = createOpenLibraryClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ docs: [{ ...openEdition, key: '/works/OL66554W', edition_key: ['OL7353617M'], author_name: ['Jane Austen'], author_key: ['OL1A'], cover_i: 123, publish_year: [1813, 2003] }] });
  } });

  const candidates = await client.searchWorks({ title: ' Pride and Prejudice ', author: ' Jane Austen ' });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.hostname, 'openlibrary.org');
  assert.equal(url.searchParams.get('title'), 'Pride and Prejudice');
  assert.equal(url.searchParams.get('author'), 'Jane Austen');
  assert.match(calls[0].options.headers['User-Agent'], /BookishCatalogResolver/);
  assert.deepEqual(candidates[0].providerIds, { workId: 'OL66554W', editionId: 'OL7353617M' });
  assert.deepEqual(candidates[0].languages, ['eng']);
  assert.deepEqual(candidates[0].isbn13, [isbn]);
  assert.deepEqual(candidates[0].publicationYears, [2003, 1813]);
  assert.equal(candidates[0].coverImageUrls[0], 'https://covers.openlibrary.org/b/id/123-L.jpg?default=false');
});

test('Open Library fetches work and edition details and treats 404 as no result', async () => {
  const client = createOpenLibraryClient({ fetchImpl: async url => {
    if (url.includes('/works/OL66554W/editions.json')) return Response.json({ entries: [{ ...openEdition, key: '/books/OL7353617M' }] });
    if (url.includes('/works/OL66554W.json')) return Response.json({ title: 'Pride and Prejudice', authors: [{ author: { key: '/authors/OL1A' } }], subjects: ['Fiction'] });
    if (url.includes('/books/OL7353617M.json')) return Response.json(openEdition);
    return new Response('', { status: 404 });
  } });

  const work = await client.fetchWork('OL66554W');
  assert.deepEqual(work.providerIds, { workId: 'OL66554W', editionId: null });
  assert.deepEqual(work.authorKeys, ['OL1A']);
  const edition = await client.fetchEdition('OL7353617M');
  assert.deepEqual(edition.providerIds, { workId: 'OL66554W', editionId: 'OL7353617M' });
  assert.equal((await client.fetchEditionsForWork('OL66554W')).length, 1);
  assert.equal(await client.fetchWork('OL99999W'), null);
  assert.deepEqual(await client.searchWorks({ title: 'Missing', author: 'Nobody' }), []);
});

test('Open Library reports malformed payloads and restricts redirects', async () => {
  const malformed = createOpenLibraryClient({ fetchImpl: async () => Response.json([]) });
  await assert.rejects(malformed.searchWorks({ title: 'Book', author: 'Author' }), expectProviderError(error => error.code === 'malformed_response' && !error.retryable));
  const malformedJson = createOpenLibraryClient({ fetchImpl: async () => new Response('{', { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(malformedJson.fetchWork('OL1W'), expectProviderError(error => error.code === 'malformed_response' && !error.retryable));

  let calls = 0;
  const redirected = createOpenLibraryClient({ fetchImpl: async url => {
    calls++;
    if (url.includes('OL1M.json')) return new Response('', { status: 302, headers: { location: '/books/OL2M.json' } });
    return Response.json(openEdition);
  } });
  assert.equal((await redirected.fetchEdition('OL1M')).providerIds.editionId, 'OL1M');
  assert.equal(calls, 2);

  const rejected = createOpenLibraryClient({ fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://example.test/books/OL2M.json' } }) });
  await assert.rejects(rejected.fetchEdition('OL1M'), expectProviderError(error => error.code === 'unexpected_redirect' && error.status === 302 && !error.retryable));
});

test('Open Library retries only transient timeout, 429 and 5xx responses', async () => {
  const scenarios = [
    { failure: Object.assign(new Error('slow'), { name: 'TimeoutError' }), expectedCode: 'timeout' },
    { failure: new Response('', { status: 429 }), expectedCode: 'http_429' },
    { failure: new Response('', { status: 503 }), expectedCode: 'http_5xx' },
  ];
  for (const { failure } of scenarios) {
    let calls = 0;
    const sleeps = [];
    const client = createOpenLibraryClient({
      sleep: async milliseconds => sleeps.push(milliseconds),
      fetchImpl: async () => ++calls === 1 ? failure instanceof Response ? failure : Promise.reject(failure) : Response.json({ title: 'Pride and Prejudice', authors: [] }),
    });
    assert.equal((await client.fetchWork('OL1W')).title, 'Pride and Prejudice');
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [500]);
  }

  let calls = 0;
  const client = createOpenLibraryClient({ sleep: async () => {}, fetchImpl: async () => { calls++; return new Response('', { status: 400 }); } });
  await assert.rejects(client.fetchWork('OL1W'), expectProviderError(error => error.code === 'http_400' && error.status === 400 && !error.retryable && error.attempts === 1));
  assert.equal(calls, 1);
});

test('Open Library honors a capped Retry-After delay through injected sleep', async () => {
  let calls = 0;
  const sleeps = [];
  const client = createOpenLibraryClient({
    sleep: async milliseconds => sleeps.push(milliseconds),
    fetchImpl: async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '120' } }) : Response.json({ title: 'Pride and Prejudice', authors: [] }),
  });
  await client.fetchWork('OL1W');
  assert.deepEqual(sleeps, [MAX_RETRY_AFTER_MS]);
  assert.equal(retryAfterMs('120'), MAX_RETRY_AFTER_MS);
});

test('Google Books searches title and author and exposes normalized volume candidates', async () => {
  const calls = [];
  const client = createGoogleBooksClient({ fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ items: [googleVolume] }); } });
  const candidates = await client.searchVolumes({ title: ' Pride and Prejudice ', author: ' Jane Austen ' });
  const url = new URL(calls[0].url);
  assert.equal(url.hostname, 'www.googleapis.com');
  assert.equal(url.searchParams.get('q'), 'intitle:Pride and Prejudice inauthor:Jane Austen');
  assert.equal(candidates[0].providerIds.volumeId, 'volume-1');
  assert.deepEqual(candidates[0].isbn13, [isbn]);
  assert.deepEqual(candidates[0].coverImageUrls, ['https://books.google.com/books/content?id=volume-1']);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
});

test('Google Books exact ISBN lookup accepts only a matching ISBN', async () => {
  const matching = createGoogleBooksClient({ fetchImpl: async url => {
    assert.equal(new URL(url).searchParams.get('q'), `isbn:${isbn}`);
    return Response.json({ items: [googleVolume] });
  } });
  assert.equal((await matching.lookupByIsbn('978-0-14-143951-8')).providerIds.volumeId, 'volume-1');

  const mismatched = createGoogleBooksClient({ fetchImpl: async () => Response.json({ items: [{ ...googleVolume, volumeInfo: { ...googleVolume.volumeInfo, industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780140435962' }] } }] }) });
  assert.equal(await mismatched.lookupByIsbn(isbn), null);
  const notFound = createGoogleBooksClient({ fetchImpl: async () => new Response('', { status: 404 }) });
  assert.equal(await notFound.lookupByIsbn(isbn), null);
});

test('Google Books reports malformed responses and retries only transient failures', async () => {
  const malformed = createGoogleBooksClient({ fetchImpl: async () => Response.json([]) });
  await assert.rejects(malformed.searchVolumes({ title: 'Book', author: 'Author' }), expectProviderError(error => error.code === 'malformed_response' && !error.retryable));

  for (const failure of [Object.assign(new Error('offline'), { name: 'TypeError' }), new Response('', { status: 429 }), new Response('', { status: 502 })]) {
    let calls = 0;
    const sleeps = [];
    const client = createGoogleBooksClient({
      sleep: async milliseconds => sleeps.push(milliseconds),
      fetchImpl: async () => ++calls === 1 ? failure instanceof Response ? failure : Promise.reject(failure) : Response.json({ items: [googleVolume] }),
    });
    assert.equal((await client.searchVolumes({ title: 'Book', author: 'Author' })).length, 1);
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [500]);
  }

  let calls = 0;
  const nonRetryable = createGoogleBooksClient({ sleep: async () => {}, fetchImpl: async () => { calls++; return new Response('', { status: 401 }); } });
  await assert.rejects(nonRetryable.searchVolumes({ title: 'Book', author: 'Author' }), expectProviderError(error => error.code === 'http_401' && error.status === 401 && !error.retryable && error.attempts === 1));
  assert.equal(calls, 1);
});

test('provider errors retain bounded retry attempts and classifications', async () => {
  const sleeps = [];
  await assert.rejects(
    requestProvider({ provider: 'test_provider', stage: 'request', url: 'https://example.test/metadata', sleep: async milliseconds => sleeps.push(milliseconds), fetchImpl: async () => new Response('', { status: 503 }) }),
    expectProviderError(error => error.code === 'http_5xx' && error.status === 503 && error.retryable && error.attempts === 3),
  );
  assert.deepEqual(sleeps, [500, 1500]);
});
