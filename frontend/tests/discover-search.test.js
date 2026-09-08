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
    if (url.pathname === '/api/auth/login') return Response.json({ user: { id: 'reader', username: 'reader' }, accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`, expiresIn: 900 });
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
  const clearAuthor = [...document.querySelectorAll('.active-filter')].find(button => button.textContent.includes('Jane Austen'));
  assert.ok(clearAuthor, 'active author has a visible clear action');
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
  await act(async () => clear.click());
  assert.equal(document.querySelector('#location').textContent, '?sort=publicationYear&order=asc');
  assert.equal(document.querySelector('#book-search').value, '');
});
