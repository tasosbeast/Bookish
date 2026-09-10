import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('My Books removes a deleted shelf entry even when reconciliation fails', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/my-books' });
  const original = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(navigator, 'locks', { value: { request: (_key, _options, work) => work() } });
  const nativeFetch = globalThis.fetch;
  let server, root, session, blocked = true, present = true, failedRefresh = false, refreshFailures = 0, removals = 0, confirmations = 0;
  dom.window.confirm = () => { confirmations++; return true; };
  const book = { id: 'book-a', title: 'A removable book', author: 'An author', coverImageUrl: null, averageRating: 4, genres: [] };
  const shelf = { bookId: book.id, status: 'read', userRating: 4, book };
  const response = (body, status = 200) => Response.json(body, { status });
  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    session?.destroy(); await server?.close(); dom.window.close(); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') return response({ user: { id: 'reader', username: 'reader' }, accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`, expiresIn: 900 });
    if (options.method === 'DELETE') {
      removals++;
      if (blocked) return response({ error: { code: 'REVIEW_BLOCKS_SHELF_REMOVAL', message: 'Remove your review before removing this book from My Books' } }, 409);
      present = false; return response({ data: { bookId: book.id, removed: true } });
    }
    if (url.pathname === `/api/user-books/${book.id}`) return response({ data: { bookId: book.id, shelf, review: null } });
    if (url.pathname === '/api/user-books' && failedRefresh) { refreshFailures++; throw new TypeError('Shelf refresh unavailable'); }
    return response({ data: present ? [shelf] : [], pagination: { page: 1, limit: 10, total: present ? 1 : 0, totalPages: present ? 1 : 0 } });
  };
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const { default: MyBooks } = await server.ssrLoadModule('/src/pages/MyBooks.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter } = await import('react-router-dom');
  const click = async text => act(async () => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text);
    assert.ok(button, `${text} button exists`); button.click();
  });
  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/my-books'] }, h(MyBooks))));
  const update = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === `Update reading for ${book.title}`);
  assert.ok(update, 'the shelf editor control identifies its book');
  await act(async () => update.click());
  await click('Remove from My Books');
  assert.equal(confirmations, 1); assert.equal(removals, 1);
  assert.ok(document.body.textContent.includes('Remove your review before removing this book from My Books'));
  assert.ok(document.body.textContent.includes(book.title));
  blocked = false;
  failedRefresh = true;
  await click('Remove from My Books');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.equal(confirmations, 2); assert.equal(removals, 2);
  assert.equal(refreshFailures, 1, 'the background reconciliation request failed');
  assert.ok(!document.body.textContent.includes(book.title));
  assert.ok(document.body.textContent.includes('Your reading story starts here'));
});
