import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isbn13, mapEdition, mapGenres, openLibrary, saveMetadata, importCatalog } from '../scripts/catalog.js';
const isbn = '9780141439518';
const edition = { title: 'Pride and Prejudice', isbn_13: [isbn], publish_date: 'January 1, 2003', covers: [-1, 123], subjects: [' Fiction ', 'FICTION', 'Fantasy fiction', 'noise'] };
test('catalog ISBN checksum and committed manifest', () => {
  assert.equal(isbn13('978-0-14-143951-8'), isbn);
  for (const value of ['9780141439519', '978014143951', null, 9780141439518, '1234567890128']) assert.throws(() => isbn13(value));
  const entries = JSON.parse(readFileSync(new URL('../scripts/catalog.json', import.meta.url)));
  assert.equal(entries.length, 250);
  assert.equal(new Set(entries.map(e => isbn13(e.isbn))).size, 250);
});
test('catalog maps edition metadata conservatively and genres predictably', () => {
  const data = mapEdition(isbn, edition, [' Jane Austen ', 'Jane Austen'], { description: { value: 'Description' } });
  assert.equal(data.author, 'Jane Austen'); assert.equal(data.publicationYear, 2003);
  assert.equal(data.coverImageUrl, 'https://covers.openlibrary.org/b/id/123-L.jpg?default=false');
  assert.equal(data.description, 'Description'); assert.equal(data.averageRating, undefined);
  assert.deepEqual(mapGenres([' science   fiction ', 'Science fiction', 'noise']), [{name:'Science Fiction',slug:'science-fiction'}]);
  assert.equal(mapEdition(isbn, edition, []), null);
  assert.equal(mapEdition(isbn, edition, [undefined]), null);
  assert.throws(() => mapEdition(isbn, {...edition,isbn_13:[]}, ['Author']));
  for (const publish_date of ['2001–2005', '[2003]', 'circa 2003', 'unknown']) assert.equal(mapEdition(isbn, {...edition,publish_date}, ['Author']).publicationYear, null);
  const missing = mapEdition(isbn, {title:'Title',isbn_13:[isbn]}, ['Author']);
  assert.equal(missing.coverImageUrl,null); assert.equal(missing.description,null); assert.equal(missing.publicationYear,null);
});
test('catalog HTTP requests are constrained, paced and handle malformed/network failures', async () => {
  const urls = [], sleeps = [];
  const resolve = openLibrary({sleep: async ms => sleeps.push(ms), fetchImpl: async (url, options) => {
    urls.push(url); assert.ok(options.signal); assert.match(options.headers['User-Agent'], /Bookish/);
    return Response.json(url.includes('/isbn/') ? {...edition,authors:[{key:'/authors/OL1A'}]} : {name:'Jane Austen'});
  }});
  assert.equal((await resolve(isbn)).title, edition.title); assert.equal(urls.length,2); assert.deepEqual(sleeps,[1100]);
  assert.ok(urls.every(url => !url.includes('googleapis.com')));
  await assert.rejects(() => resolve('bad')); assert.equal(urls.length,2);
  for (const fetchImpl of [async()=>{throw new Error('offline')},async()=>new Response('broken'),async()=>Response.json([]),async()=>new Response('',{status:429})]) await assert.rejects(openLibrary({fetchImpl,sleep:async()=>{}})(isbn));
  assert.equal(await openLibrary({fetchImpl:async()=>new Response('',{status:404})})(isbn),null);
});
test('catalog retries only bounded transient requests while preserving pacing', async () => {
  const resolver = ({ transient, noCover = false }) => {
    const sleeps = [], calls = [];
    const resolve = openLibrary({ sleep: async ms => sleeps.push(ms), fetchImpl: async url => {
      calls.push(url);
      if (calls.length === 1 && transient) return transient instanceof Error ? Promise.reject(transient) : new Response('', { status: transient });
      if (url.includes('/isbn/')) return Response.json({ ...edition, covers: noCover ? [] : edition.covers, authors: [{ key: '/authors/OL1A' }] });
      if (url.includes('/authors/')) return Response.json({ name: 'Jane Austen' });
      if (url.includes('googleapis.com')) return Response.json({ items: [{ volumeInfo: { industryIdentifiers: [{ type: 'ISBN_13', identifier: isbn }], imageLinks: { large: 'https://books.google.com/books/content?id=cover' } } }] });
      throw new Error('Unexpected request');
    }});
    return { resolve, sleeps, calls };
  };
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  for (const transient of [timeout, 429, 503]) {
    const { resolve, sleeps, calls } = resolver({ transient });
    assert.equal((await resolve(isbn)).title, edition.title);
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [250, 1100, 1100]);
  }
  let notFoundCalls = 0;
  assert.equal(await openLibrary({ sleep: async () => {}, fetchImpl: async () => { notFoundCalls++; return new Response('', { status: 404 }); } })(isbn), null);
  assert.equal(notFoundCalls, 1);
  let malformedCalls = 0;
  await assert.rejects(openLibrary({ sleep: async () => {}, fetchImpl: async () => { malformedCalls++; return Response.json([]); } })(isbn));
  assert.equal(malformedCalls, 1);
});
test('catalog retries Google Books covers without blocking valid metadata', async () => {
  const noCover = { ...edition, covers: [], authors: [{ key: '/authors/OL1A' }] };
  const run = google => {
    let googleCalls = 0;
    const resolve = openLibrary({ sleep: async () => {}, fetchImpl: async url => {
      if (url.includes('/isbn/')) return Response.json(noCover);
      if (url.includes('/authors/')) return Response.json({ name: 'Jane Austen' });
      googleCalls++;
      return google(googleCalls);
    }});
    return { resolve, googleCalls: () => googleCalls };
  };
  const cover = { items: [{ volumeInfo: { industryIdentifiers: [{ type: 'ISBN_13', identifier: isbn }], imageLinks: { large: 'https://books.google.com/books/content?id=cover' } } }] };
  const retry = run(calls => calls === 1 ? new Response('', { status: 429 }) : Response.json(cover));
  assert.equal((await retry.resolve(isbn)).coverImageUrl, 'https://books.google.com/books/content?id=cover');
  assert.equal(retry.googleCalls(), 2);
  const repeatedFailure = run(() => new Response('', { status: 503 }));
  assert.equal((await repeatedFailure.resolve(isbn)).coverImageUrl, null);
  assert.equal(repeatedFailure.googleCalls(), 3);
});
test('catalog uses an exact-ISBN Google Books cover only when Open Library has none', async () => {
  const noCover = { ...edition, covers: [], authors: [{ key: '/authors/OL1A' }] };
  const resolve = google => openLibrary({ sleep: async () => {}, fetchImpl: async url => {
    const parsed = new URL(url);
    if (parsed.hostname === 'openlibrary.org') return Response.json(parsed.pathname.startsWith('/isbn/') ? noCover : { name: 'Jane Austen' });
    assert.equal(parsed.hostname, 'www.googleapis.com');
    assert.equal(parsed.searchParams.get('q'), `isbn:${isbn}`);
    return typeof google === 'function' ? google() : google;
  }});
  const exact = imageLinks => ({ items: [{ volumeInfo: { industryIdentifiers: [{ type: 'ISBN_13', identifier: isbn }], imageLinks } }] });
  const covered = await resolve(Response.json(exact({ large: 'http://books.google.com/books/content?id=cover&printsec=frontcover' })))(isbn);
  assert.equal(covered.coverImageUrl, 'https://books.google.com/books/content?id=cover&printsec=frontcover');
  assert.equal((await resolve(Response.json(exact({ thumbnail: 'https://books.google.com/placeholder.jpg' })))(isbn)).coverImageUrl, null);
  assert.equal((await resolve(() => { throw new Error('Google Books unavailable'); })(isbn)).coverImageUrl, null);
  const mismatched = { items: [{ volumeInfo: { industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780140435962' }], imageLinks: { large: 'https://books.google.com/books/content?id=wrong' } } }] };
  assert.equal((await resolve(Response.json(mismatched))(isbn)).coverImageUrl, null);
});
test('catalog does not replace a stored Open Library cover with a Google Books fallback', async () => {
  const metadata = { ...mapEdition(isbn, { ...edition, covers: [] }, ['Jane Austen']), coverImageUrl: 'https://books.google.com/books/content?id=google-cover' };
  const existing = { ...metadata, coverImageUrl: 'https://covers.openlibrary.org/b/id/123-L.jpg?default=false', bookGenres: metadata.genres.map(genre => ({ genre })) };
  let upserts = 0;
  const db = { $transaction: work => work({
    book: { findUnique: async () => existing, upsert: async () => { upserts++; } },
    genre: { upsert: async () => {} }, bookGenre: { upsert: async () => {} },
  }) };
  assert.equal(await saveMetadata(db, metadata, true), 'unchanged');
  assert.equal(upserts, 0);
});
test('catalog follows only a bounded same-origin edition redirect', async () => {
  const resolver = openLibrary({ sleep: async () => {}, fetchImpl: async url => {
    if (url.endsWith(`/isbn/${isbn}.json`)) return new Response('', { status: 302, headers: { location: '/books/OL1M.json' } });
    if (url.endsWith('/books/OL1M.json')) return Response.json({ ...edition, authors: [{ key: '/authors/OL1A' }] });
    return Response.json({ name: 'Jane Austen' });
  }});
  assert.equal((await resolver(isbn)).isbn, isbn);
  await assert.rejects(openLibrary({ fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://example.test/book.json' } }) })(isbn));
});
test('catalog deduplicates before requests and continues after partial failures', async () => {
  const seen=[];
  const summary=await importCatalog([{isbn},{isbn:'978-0-14-143951-8'},{isbn:'bad'},{isbn:'9780451524935'},{isbn:'9780451526342'}], {
    resolve:async key=> {seen.push(key); if(key==='9780451524935') throw new Error('offline'); return key===isbn ? mapEdition(isbn,edition,['Author']) : null;}, save:async()=> 'created',
  });
  assert.equal(seen.length,3); assert.deepEqual(summary,{created:1,updated:0,unchanged:0,skipped:2,failed:2,resolved:1});
});
