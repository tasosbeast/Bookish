import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('My Books search filtering, state retention and parameter composition', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/my-books' });
  const original = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true
  })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(navigator, 'locks', { value: { request: (_key, _options, work) => work() } });
  const nativeFetch = globalThis.fetch;
  let server, root, session;

  const setInputValue = (el, val) => {
    const proto = dom.window.HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    valueSetter.call(el, val);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };

  const requests = [];

  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    session?.destroy(); await server?.close(); dom.window.close(); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });

  const duneBook = { id: 'book-dune', title: 'Dune', author: 'Frank Herbert', coverImageUrl: null, averageRating: 4.8, genres: [] };
  const foundationBook = { id: 'book-foundation', title: 'Foundation', author: 'Isaac Asimov', coverImageUrl: null, averageRating: 4.7, genres: [] };

  const entry = (book, status) => ({ bookId: book.id, status, userRating: null, book });
  const response = (body, status = 200) => Response.json(body, { status });

  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') {
      return response({ user: { id: 'reader', username: 'reader' }, accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`, expiresIn: 900 });
    }
    requests.push(url);

    const q = url.searchParams.get('q');
    const status = url.searchParams.get('status');

    let items = [entry(duneBook, 'read'), entry(foundationBook, 'want_to_read')];
    if (status) items = items.filter(e => e.status === status);
    if (q) items = items.filter(e => e.book.title.toLowerCase().includes(q.toLowerCase()) || e.book.author.toLowerCase().includes(q.toLowerCase()));

    return response({
      data: items,
      pagination: { page: Number(url.searchParams.get('page') || 1), limit: 10, total: items.length, totalPages: 1 }
    });
  };

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] }
  });
  const { default: MyBooks } = await server.ssrLoadModule('/src/pages/MyBooks.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, useLocation } = await import('react-router-dom');

  function Location() { return h('output', { id: 'location' }, useLocation().search); }

  await session.authenticate('login', {});

  // 1. Initialized with ?status=read&q=dune
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/my-books?status=read&q=dune'] }, h(MyBooks), h(Location))));

  // Pre-fills input from ?q=
  const searchInput = document.querySelector('#my-books-search');
  assert.equal(searchInput.value, 'dune');
  assert.ok(document.body.textContent.includes('Dune'));
  assert.ok(!document.body.textContent.includes('Foundation'));

  // 2. Changing status preserves q
  const wantToReadBtn = [...document.querySelectorAll('.shelf-tabs button')].find(b => b.textContent.trim() === 'Want to read');
  await act(async () => wantToReadBtn.click());
  assert.equal(document.querySelector('#location').textContent, '?status=want_to_read&q=dune');

  // 3. Submitting new search preserves status
  await act(async () => {
    setInputValue(searchInput, 'asimov');
  });
  const form = document.querySelector('form.search-box');
  await act(async () => {
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(document.querySelector('#location').textContent, '?status=want_to_read&q=asimov');
  assert.ok(document.body.textContent.includes('Foundation'));

  // 4. Clearing search preserves status
  const clearBtn = document.querySelector('.active-filter');
  assert.ok(clearBtn, 'active search filter pill should exist');
  await act(async () => clearBtn.click());
  assert.equal(document.querySelector('#location').textContent, '?status=want_to_read');

  // 5. Search with no results shows appropriate empty state
  await act(async () => {
    setInputValue(searchInput, 'nonexistent');
  });
  await act(async () => {
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.ok(document.body.textContent.includes('No want to read books match “nonexistent”') || document.body.textContent.includes('No books match “nonexistent”'));
});
