import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('My Books shelf editor displays correct review link', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/my-books' });
  const original = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(navigator, 'locks', { value: { request: (_key, _options, work) => work() } });
  const nativeFetch = globalThis.fetch;
  let server, root, session;
  
  const bookNoReview = { id: 'book-1', title: 'Book One', author: 'Author One', averageRating: 4, genres: [] };
  const bookWithReview = { id: 'book-2', title: 'Book Two', author: 'Author Two', averageRating: 4, genres: [] };
  
  const shelfEntries = [
    { bookId: 'book-1', status: 'read', userRating: null, book: bookNoReview },
    { bookId: 'book-2', status: 'read', userRating: 4, book: bookWithReview }
  ];

  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    session?.destroy(); await server?.close(); dom.window.close(); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });

  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') return Response.json({ user: { id: 'reader', username: 'reader' }, accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`, expiresIn: 900 });
    if (url.pathname === '/api/user-books') {
      return Response.json({ data: shelfEntries, pagination: { page: 1, limit: 10, total: 2, totalPages: 1 } });
    }
    if (url.pathname === '/api/user-books/book-1') {
      return Response.json({ data: { bookId: 'book-1', status: 'read', shelf: true, userRating: null, review: null } });
    }
    if (url.pathname === '/api/user-books/book-2') {
      return Response.json({ data: { bookId: 'book-2', status: 'read', shelf: true, userRating: 4, review: { id: 'rev-1', rating: 4, reviewText: 'Great' } } });
    }
    return Response.json({});
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
  
  // Wait for the shelf to load
  assert.ok(document.body.textContent.includes('Book One'));
  assert.ok(document.body.textContent.includes('Book Two'));

  // Check the review link for Book One
  const link1 = [...document.querySelectorAll('.shelf-personal a')].find(a => a.href.includes('/books/book-1#review'));
  assert.ok(link1, 'Review link for book-1 should be present');
  assert.equal(link1.textContent, 'Review');

  // Check the review link for Book Two
  const link2 = [...document.querySelectorAll('.shelf-personal a')].find(a => a.href.includes('/books/book-2#review'));
  assert.ok(link2, 'Review link for book-2 should be present');
  assert.equal(link2.textContent, 'Review');
});
