import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('My Books renders finishedOn for Read books and hides it for other statuses', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/my-books' });
  const original = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    BroadcastChannel: undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(navigator, 'locks', { value: { request: (_key, _options, work) => work() } });
  const nativeFetch = globalThis.fetch;
  let server, root, session;

  const book1 = { id: 'book-1', title: 'Finished Read Book', author: 'Author One', averageRating: 4, genres: [] };
  const book2 = { id: 'book-2', title: 'Currently Reading Book', author: 'Author Two', averageRating: null, genres: [] };
  const book3 = { id: 'book-3', title: 'Want to Read Book', author: 'Author Three', averageRating: 5, genres: [] };
  const book4 = { id: 'book-4', title: 'Read Book No Date', author: 'Author Four', averageRating: null, genres: [] };

  const shelfEntries = [
    { bookId: 'book-1', status: 'read', finishedOn: '2026-09-05', userRating: 4, book: book1 },
    { bookId: 'book-2', status: 'currently_reading', finishedOn: null, userRating: null, book: book2 },
    { bookId: 'book-3', status: 'want_to_read', finishedOn: null, userRating: 5, book: book3 },
    { bookId: 'book-4', status: 'read', finishedOn: null, userRating: null, book: book4 },
  ];

  t.after(async () => {
    if (root) {
      const { act } = await import('react');
      await act(async () => root.unmount());
    }
    session?.destroy();
    await server?.close();
    dom.window.close();
    globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) {
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
    }
  });

  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') {
      return Response.json({
        user: { id: 'reader', username: 'reader' },
        accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`,
        expiresIn: 900,
      });
    }
    if (url.pathname === '/api/user-books') {
      return Response.json({
        data: shelfEntries,
        pagination: { page: 1, limit: 10, total: 4, totalPages: 1 },
      });
    }
    return Response.json({});
  };

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  const { default: MyBooks } = await server.ssrLoadModule('/src/pages/MyBooks.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter } = await import('react-router-dom');

  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/my-books'] }, h(MyBooks))));

  const articles = Array.from(document.querySelectorAll('.shelf-row'));
  assert.equal(articles.length, 4);

  // 1. Read book with finishedOn: renders "Finished Sep 5, 2026"
  const row1 = articles[0];
  assert.ok(row1.textContent.includes('Finished Read Book'));
  assert.ok(row1.textContent.includes('Finished Sep 5, 2026'), 'Renders Finished Sep 5, 2026 for Read book');
  
  // Verify order in row1: status-badge -> Finished date -> Your rating -> Update reading -> Review
  const personal1 = row1.querySelector('.shelf-personal');
  const personal1Children = Array.from(personal1.children);
  assert.equal(personal1Children[0].className, 'status-badge');
  assert.equal(personal1Children[0].textContent.trim(), 'Read');
  assert.equal(personal1Children[1].textContent.trim(), 'Finished Sep 5, 2026');
  assert.equal(personal1Children[2].textContent.trim(), 'Your rating: 4 / 5');
  assert.ok(personal1Children[3].textContent.includes('Update reading'));
  assert.ok(personal1Children[4].textContent.includes('Review'));

  // 2. Currently Reading book: does NOT render Finished text
  const row2 = articles[1];
  assert.ok(row2.textContent.includes('Currently Reading Book'));
  assert.equal(row2.textContent.includes('Finished'), false, 'Currently Reading does not render Finished');

  // 3. Want to Read book: does NOT render Finished text
  const row3 = articles[2];
  assert.ok(row3.textContent.includes('Want to Read Book'));
  assert.equal(row3.textContent.includes('Finished'), false, 'Want to Read does not render Finished');

  // 4. Read book with no finishedOn: does NOT render Finished text
  const row4 = articles[3];
  assert.ok(row4.textContent.includes('Read Book No Date'));
  assert.equal(row4.textContent.includes('Finished'), false, 'Read without finishedOn does not render Finished');
});
