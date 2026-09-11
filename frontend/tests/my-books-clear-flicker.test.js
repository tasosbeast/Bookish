import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('My Books prevents transient empty-state CTA flicker when clearing filters or search', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/my-books?status=read' });
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
  let resolvePending;
  let returnEmptyUnfiltered = false;

  const sampleBook = { id: 'b1', title: 'Sample Book', author: 'Author One', coverImageUrl: null, averageRating: 4, genres: [] };
  const entry = (book, status) => ({ bookId: book.id, status, userRating: null, book });
  const response = (body, status = 200) => Response.json(body, { status });
  const shelfResponse = entries => response({ data: entries, pagination: { page: 1, limit: 10, total: entries.length, totalPages: 1 } });

  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    session?.destroy(); await server?.close(); dom.window.close(); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });

  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') {
      return response({ user: { id: 'reader', username: 'reader' }, accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`, expiresIn: 900 });
    }
    const status = url.searchParams.get('status');
    const q = url.searchParams.get('q');

    if (resolvePending) {
      return new Promise(resolve => {
        const prevResolve = resolvePending;
        resolvePending = (overrideEmpty) => {
          const items = overrideEmpty ? [] : [entry(sampleBook, 'currently_reading')];
          resolve(shelfResponse(items));
        };
      });
    }

    if (status === 'read' || q === 'nonexistent') {
      return shelfResponse([]); // Empty shelf for status=read or q=nonexistent
    }

    const items = returnEmptyUnfiltered ? [] : [entry(sampleBook, 'currently_reading')];
    return shelfResponse(items);
  };

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }
  });

  const { default: MyBooks } = await server.ssrLoadModule('/src/pages/MyBooks.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter } = await import('react-router-dom');

  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));

  // 1. Initialized with status=read (empty)
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/my-books?status=read'] }, h(MyBooks))));

  // "Clear filters" is visible on empty status shelf
  const clearFiltersBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear filters');
  assert.ok(clearFiltersBtn, 'Clear filters button must be visible on empty status shelf');
  assert.equal(document.body.textContent.includes('Discover books'), false);

  // 2. Click "Clear filters" while the new request is pending
  resolvePending = () => {};
  await act(async () => clearFiltersBtn.click());

  // While request is pending, "Discover books" must NOT appear
  const discoverBtnWhilePending = [...document.querySelectorAll('a, button')].find(b => b.textContent.trim() === 'Discover books');
  assert.equal(discoverBtnWhilePending, undefined, 'Discover books CTA must NOT appear while request is pending');
  assert.ok(document.body.textContent.includes('Updating shelf…'));

  // 3. Fresh unfiltered data returns with books
  const pendingResolver = resolvePending;
  resolvePending = null;
  await act(async () => pendingResolver(false));

  // Books appear, no incorrect empty CTA remains
  assert.ok(document.body.textContent.includes('Sample Book'));
  assert.equal(document.body.textContent.includes('Discover books'), false);

  // 4. Test when fresh unfiltered data genuinely returns empty
  // Reset view to ?q=nonexistent
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/my-books?q=nonexistent'] }, h(MyBooks))));

  const clearSearchPill = document.querySelector('.active-filter');
  assert.ok(clearSearchPill, 'Clear search pill exists');
  
  resolvePending = () => {};
  returnEmptyUnfiltered = true; // Simulating a genuinely empty user library
  await act(async () => clearSearchPill.click());

  // While request is pending, "Discover books" must NOT appear
  assert.equal([...document.querySelectorAll('a, button')].some(b => b.textContent.trim() === 'Discover books'), false);
  assert.ok(document.body.textContent.includes('Updating shelf…'));

  // Fresh response resolves with 0 books
  const searchResolver = resolvePending;
  resolvePending = null;
  await act(async () => searchResolver(true));

  // "Discover books" appears only AFTER fresh response arrives
  const discoverBtnFinal = [...document.querySelectorAll('a, button')].find(b => b.textContent.trim() === 'Discover books');
  assert.ok(discoverBtnFinal, 'Discover books appears after fresh empty response arrives');
});
