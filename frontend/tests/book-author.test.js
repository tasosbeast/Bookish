import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Book Details links an author to the Discover author filter', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/books/book-id' });
  const original = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(navigator, 'locks', { value: { request: (_key, _options, work) => work() } });
  const nativeFetch = globalThis.fetch;
  let server, root, session;
  const response = body => Response.json(body);
  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    session?.destroy(); await server?.close(); dom.window.close(); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') return response({ user: { id: 'reader', username: 'reader' }, accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`, expiresIn: 900 });
    if (url.pathname === '/api/user-books/book-id') return response({ data: { bookId: 'book-id', shelf: null, review: null } });
    return response({ data: { id: 'book-id', title: 'A book', author: 'Jane Austen', description: null, coverImageUrl: null, averageRating: null, ratingsCount: 0, genres: [], reviews: { data: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } } } });
  };
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const { default: BookDetails } = await server.ssrLoadModule('/src/pages/BookDetails.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, Routes, Route, useLocation } = await import('react-router-dom');
  function Location() { return h('output', { id: 'location' }, useLocation().search); }
  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/books/book-id'] }, h(Routes, null, h(Route, { path: '/books/:id', element: h(BookDetails) }), h(Route, { path: '/', element: h('div') })), h(Location))));
  const author = document.querySelector('.detail-author .author-filter');
  assert.equal(author.textContent, 'Jane Austen');
  await act(async () => author.click());
  assert.equal(document.querySelector('#location').textContent, '?author=Jane%20Austen');
});
