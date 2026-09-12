import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Discover defaults to newest published and clearing search preserves explicit filters', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173' });
  const original = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(navigator, 'locks', { value: { request: (_key, _options, work) => work() } });
  const nativeFetch = globalThis.fetch;
  let server, root, session;
  const requests = [];
  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    session?.destroy(); await server?.close(); dom.window.close(); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/api/genres') return Response.json({ data: [
      { id: '1', name: 'Fiction', slug: 'fiction' },
      { id: '2', name: 'Fantasy', slug: 'fantasy' },
      { id: '3', name: 'Science Fiction', slug: 'science-fiction' },
      { id: '4', name: 'Mystery', slug: 'mystery' },
      { id: '5', name: 'Romance', slug: 'romance' },
      { id: '6', name: 'History', slug: 'history' },
      { id: '7', name: 'Biography', slug: 'biography' },
      { id: '8', name: 'Science', slug: 'science' },
      { id: '9', name: 'Philosophy', slug: 'philosophy' },
      { id: '10', name: 'Poetry', slug: 'poetry' },
      { id: '11', name: 'Children', slug: 'children' },
    ] });
    requests.push(url);
    return Response.json({ data: [{ id: 'book-id', title: 'A book', author: 'Jane Austen', coverImageUrl: null, averageRating: null, genres: [] }], pagination: { page: 2, limit: 18, total: 1, totalPages: 1 } });
  };
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const { default: Discover } = await server.ssrLoadModule('/src/pages/Discover.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, useLocation } = await import('react-router-dom');
  function Location() { return h('output', { id: 'location' }, useLocation().search); }
  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/'] }, h(Discover), h(Location))));
  assert.equal(document.querySelector('#book-sort').value, 'publicationYear:desc');
  assert.deepEqual([...document.querySelectorAll('.genre-filter')].map(button => button.textContent), ['All', 'Fiction', 'Fantasy', 'Science Fiction', 'Mystery', 'Romance', 'History', 'Biography', 'Science', 'Philosophy', 'Poetry', 'Children']);
  assert.equal([...document.querySelectorAll('.genre-filter')].find(button => button.textContent === 'All').getAttribute('aria-pressed'), 'true');
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/?q=mistake&genre=fantasy&sort=publicationYear&order=asc&page=3'] }, h(Discover), h(Location))));
  assert.equal(document.querySelector('#book-sort').value, 'publicationYear:asc');
  const genreButton = name => [...document.querySelectorAll('.genre-filter')].find(button => button.textContent === name);
  assert.equal(genreButton('Fantasy').getAttribute('aria-pressed'), 'true');
  assert.ok(genreButton('Fantasy').classList.contains('active'));
  const author = document.querySelector('.book-card .author-filter');
  assert.equal(author.textContent, 'Jane Austen');
  await act(async () => author.click());
  assert.equal(document.querySelector('#location').textContent, '?q=mistake&genre=fantasy&sort=publicationYear&order=asc&author=Jane+Austen');
  assert.ok(requests.some(url => url.searchParams.get('author') === 'Jane Austen'));
  assert.ok(document.querySelector('h2').textContent.includes('Books by “Jane Austen”'));
  assert.deepEqual([...document.querySelectorAll('.active-filter-label')].map(label => label.textContent), ['mistake', 'Fantasy', 'Jane Austen']);
  const clearAuthor = [...document.querySelectorAll('.active-filter')].find(button => button.textContent.includes('Jane Austen'));
  assert.ok(clearAuthor, 'active author has a visible clear action');
  assert.equal(clearAuthor.getAttribute('aria-label'), 'Clear author filter: Jane Austen');
  await act(async () => clearAuthor.click());
  assert.equal(document.querySelector('#location').textContent, '?q=mistake&genre=fantasy&sort=publicationYear&order=asc');
  await act(async () => genreButton('Romance').click());
  assert.equal(document.querySelector('#location').textContent, '?q=mistake&genre=romance&sort=publicationYear&order=asc');
  assert.equal(genreButton('Romance').getAttribute('aria-pressed'), 'true');
  await act(async () => genreButton('All').click());
  assert.equal(document.querySelector('#location').textContent, '?q=mistake&sort=publicationYear&order=asc');
  assert.equal(genreButton('All').getAttribute('aria-pressed'), 'true');
  assert.ok(genreButton('All').classList.contains('active'));
  const clear = [...document.querySelectorAll('button')].find(button => button.textContent.includes('mistake'));
  assert.ok(clear, 'active search has a visible clear action');
  assert.equal(clear.getAttribute('aria-label'), 'Clear search filter: mistake');
  await act(async () => clear.click());
  assert.equal(document.querySelector('#location').textContent, '?sort=publicationYear&order=asc');
  assert.equal(document.querySelector('#book-search').value, '');

  const setInputValue = (el, val) => {
    const proto = dom.window.HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    valueSetter.call(el, val);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };

  const searchInput = document.querySelector('#book-search');
  assert.equal(searchInput.getAttribute('enterKeyHint'), 'search');
  searchInput.focus();
  assert.equal(document.activeElement, searchInput, 'search input can receive focus');

  let blurCount = 0;
  const originalBlur = searchInput.blur;
  searchInput.blur = function() {
    blurCount++;
    return originalBlur.apply(this, arguments);
  };

  await act(async () => {
    setInputValue(searchInput, 'Persuasion');
  });

  const searchForm = document.querySelector('form.search-box');
  await act(async () => {
    searchForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(blurCount, 1, 'submitting the form calls blur on the search input');
  assert.notEqual(document.activeElement, searchInput, 'submitting the form removes focus from the search input');
  assert.equal(document.querySelector('#location').textContent, '?sort=publicationYear&order=asc&q=Persuasion');
  assert.ok(requests.some(url => url.searchParams.get('q') === 'Persuasion'));

  searchInput.focus();
  assert.equal(document.activeElement, searchInput, 'search input can receive focus again');
  await act(async () => {
    setInputValue(searchInput, 'Emma');
  });

  const submitButton = searchForm.querySelector('button[type="submit"]');
  await act(async () => {
    submitButton.click();
  });
  assert.equal(blurCount, 2, 'clicking the website Search button calls blur on the search input');
  assert.notEqual(document.activeElement, searchInput, 'clicking the website Search button removes focus from the search input');
  assert.equal(document.querySelector('#location').textContent, '?sort=publicationYear&order=asc&q=Emma');

  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/?page=3&sort=publicationYear&order=asc'] }, h(Discover), h(Location))));

  const paginatedInput = document.querySelector('#book-search');
  let paginatedBlurCalled = false;
  paginatedInput.blur = () => { paginatedBlurCalled = true; };
  paginatedInput.focus();
  assert.equal(document.activeElement, paginatedInput);

  await act(async () => {
    setInputValue(paginatedInput, 'Mansfield');
  });

  const paginatedForm = document.querySelector('form.search-box');
  await act(async () => {
    paginatedForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.ok(paginatedBlurCalled, 'blur is called when searching from a paginated view');
  assert.equal(document.querySelector('#location').textContent, '?sort=publicationYear&order=asc&q=Mansfield', 'page param is reset on search');
});
