import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Discover retains results through a filter refresh and failed retry path', { timeout: 60000 }, async t => {
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
  const pending = [];
  const response = data => new Response(JSON.stringify(data));
  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    session?.destroy(); await server?.close(); dom.window.close(); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  globalThis.fetch = input => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') return Promise.resolve(response({ user: { id: 'reader', username: 'reader' }, accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`, expiresIn: 900 }));
    return new Promise((resolve, reject) => pending.push({ url, resolve, reject }));
  };
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const { default: Discover } = await server.ssrLoadModule('/src/pages/Discover.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter } = await import('react-router-dom');
  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/'] }, h(Discover))));
  assert.ok(document.querySelector('.skeleton-grid'), 'initial load uses catalog skeletons');
  const book = { id: 'book-a', title: 'A retained book', author: 'A reader', coverImageUrl: null, averageRating: null, genres: [] };
  await act(async () => pending.shift().resolve(response({ data: [book], pagination: { page: 1, limit: 18, total: 1, totalPages: 1 } })));
  assert.ok(document.body.textContent.includes('A retained book'));
  const fiction = [...document.querySelectorAll('.genre-filter')].find(button => button.textContent === 'Fiction');
  await act(async () => fiction.click());
  assert.ok(document.body.textContent.includes('A retained book'), 'existing results stay mounted while filters refresh');
  assert.ok(document.body.textContent.includes('Updating results…'));
  assert.equal(document.querySelector('.skeleton-grid'), null, 'refresh does not replace the catalog with initial skeletons');
  await act(async () => pending.shift().reject(new TypeError('network unavailable')));
  assert.ok(document.querySelector('[role="alert"]'), 'failed refresh reports an accessible error');
  assert.ok(document.body.textContent.includes('A retained book'), 'failed refresh does not discard the previous results');
  assert.ok(document.body.textContent.includes('Showing previous results.'));
  const retry = [...document.querySelectorAll('button')].find(button => button.textContent === 'Try again');
  await act(async () => retry.click());
  await act(async () => pending.shift().resolve(response({ data: [], pagination: { page: 1, limit: 18, total: 0, totalPages: 0 } })));
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.ok(document.body.textContent.includes('No Fiction books found'));
});
