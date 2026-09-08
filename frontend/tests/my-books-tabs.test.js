import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('My Books keeps the loaded shelf visible while a status tab reloads', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/my-books' });
  const original = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(navigator, 'locks', { value: { request: (_key, _options, work) => work() } });
  const nativeFetch = globalThis.fetch;
  let server, root, session, resolveWanted, rejectWanted;
  const allBook = { id: 'book-all', title: 'A book already on the shelf', author: 'An author', coverImageUrl: null, averageRating: 4, genres: [] };
  const wantedBook = { id: 'book-wanted', title: 'A book to read next', author: 'Another author', coverImageUrl: null, averageRating: 4, genres: [] };
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
    if (url.pathname === '/api/auth/login') return response({ user: { id: 'reader', username: 'reader' }, accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`, expiresIn: 900 });
    if (url.pathname === '/api/user-books' && url.searchParams.get('status') === 'want_to_read') {
      return new Promise((resolve, reject) => { resolveWanted = () => resolve(shelfResponse([entry(wantedBook, 'want_to_read')])); rejectWanted = () => reject(new TypeError('network unavailable')); });
    }
    return shelfResponse([entry(allBook, 'read')]);
  };
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const { default: MyBooks } = await server.ssrLoadModule('/src/pages/MyBooks.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter } = await import('react-router-dom');
  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/my-books'] }, h(MyBooks))));
  assert.ok(document.body.textContent.includes(allBook.title));
  assert.equal([...document.querySelectorAll('.shelf-tabs button')].find(button => button.textContent.trim() === 'All books').getAttribute('aria-pressed'), 'true');
  const initialList = document.querySelector('.shelf-list');
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Want to read').click());
  assert.equal(document.querySelector('.shelf-tabs button.selected').textContent, 'Want to read');
  assert.equal([...document.querySelectorAll('.shelf-tabs button')].find(button => button.textContent.trim() === 'Want to read').getAttribute('aria-pressed'), 'true');
  assert.equal([...document.querySelectorAll('.shelf-tabs button')].find(button => button.textContent.trim() === 'All books').getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector('.shelf-list'), initialList);
  assert.ok(document.body.textContent.includes(allBook.title));
  assert.ok(!document.body.textContent.includes('Finding your next chapter…'));
  assert.ok(document.body.textContent.includes('Updating shelf…'));
  await act(async () => rejectWanted());
  assert.ok(document.querySelector('[role="alert"]'));
  assert.ok(document.body.textContent.includes('Showing previous shelf.'));
  assert.ok(document.body.textContent.includes(allBook.title));
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Try again').click());
  await act(async () => resolveWanted());
  assert.ok(document.body.textContent.includes(wantedBook.title));
  assert.ok(!document.body.textContent.includes(allBook.title));
});
