import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('My Books shelf transitions to Read guide user to rating/review while other edits remain on shelf', { timeout: 60000 }, async t => {
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

  dom.window.confirm = msg => {
    assert.equal(msg, 'Remove this book from My Books?');
    return true;
  };

  const bookCr = { id: 'book-cr', title: 'Currently Reading Book', author: 'Author CR', averageRating: 4, genres: [] };
  const bookWtr = { id: 'book-wtr', title: 'Want To Read Book', author: 'Author WTR', averageRating: 4, genres: [] };
  const bookRead = { id: 'book-read', title: 'Read Book', author: 'Author Read', averageRating: 5, genres: [] };
  const bookRem = { id: 'book-rem', title: 'Removable Book', author: 'Author Rem', averageRating: 3, genres: [] };

  const shelfMap = new Map([
    ['book-cr', { bookId: 'book-cr', status: 'currently_reading', userRating: null, finishedOn: null, book: bookCr }],
    ['book-wtr', { bookId: 'book-wtr', status: 'want_to_read', userRating: null, finishedOn: null, book: bookWtr }],
    ['book-read', { bookId: 'book-read', status: 'read', userRating: 5, finishedOn: '2026-09-01', book: bookRead }],
    ['book-rem', { bookId: 'book-rem', status: 'want_to_read', userRating: null, finishedOn: null, book: bookRem }],
  ]);

  let removedIds = new Set();

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

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') {
      return Response.json({
        user: { id: 'reader', username: 'reader' },
        accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`,
        expiresIn: 900,
      });
    }

    if (options.method === 'DELETE') {
      const bookId = url.pathname.replace('/api/user-books/', '');
      removedIds.add(bookId);
      return Response.json({ data: { bookId, removed: true } });
    }

    if (options.method === 'POST' && url.pathname === '/api/user-books') {
      const body = JSON.parse(options.body);
      const existing = shelfMap.get(body.bookId);
      shelfMap.set(body.bookId, {
        ...existing,
        status: body.status,
        finishedOn: body.finishedOn ?? existing.finishedOn,
      });
      return Response.json({ data: shelfMap.get(body.bookId) });
    }

    if (url.pathname.startsWith('/api/user-books/')) {
      const bookId = url.pathname.replace('/api/user-books/', '');
      const item = shelfMap.get(bookId);
      return Response.json({
        data: {
          bookId,
          shelf: item ? { bookId: item.bookId, status: item.status, finishedOn: item.finishedOn, userRating: item.userRating } : null,
          review: null,
        },
      });
    }

    if (url.pathname === '/api/user-books') {
      const entries = [...shelfMap.values()].filter(e => !removedIds.has(e.bookId));
      return Response.json({
        data: entries,
        pagination: { page: 1, limit: 10, total: entries.length, totalPages: 1 },
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
  const { MemoryRouter, useLocation } = await import('react-router-dom');

  function Location() {
    const loc = useLocation();
    return h('output', { id: 'location' }, loc.pathname + loc.search + loc.hash);
  }

  const changeSelect = async (selectElement, value) => act(async () => {
    const prototype = dom.window.HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(selectElement, value);
    selectElement.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });

  const changeInput = async (inputElement, value) => act(async () => {
    const prototype = dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(inputElement, value);
    inputElement.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });

  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));

  let renderCount = 0;
  const renderMyBooks = async initialUrl => {
    await act(async () => {
      root.render(h(MemoryRouter, { key: `my-books-${++renderCount}`, initialEntries: [initialUrl] }, h(MyBooks), h(Location)));
    });
  };

  // 1. Currently Reading -> Read from My Books navigates to /books/:id#review
  await renderMyBooks('/my-books');
  assert.equal(document.querySelector('#location').textContent, '/my-books');

  const updateCrBtn = [...document.querySelectorAll('button')].find(
    b => b.textContent.trim() === `Update reading for ${bookCr.title}`
  );
  assert.ok(updateCrBtn, 'Update reading button exists for book-cr');
  await act(async () => updateCrBtn.click());

  const crSelect = document.querySelector('.reading-form select');
  assert.ok(crSelect, 'reading-form select rendered');
  await changeSelect(crSelect, 'read');

  const submitCrBtn = document.querySelector('.reading-form button[type="submit"]');
  await act(async () => submitCrBtn.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

  assert.equal(
    document.querySelector('#location').textContent,
    '/books/book-cr#review',
    'Currently Reading -> Read navigates to /books/book-cr#review'
  );

  // 2. Want to Read -> Read also navigates
  await renderMyBooks('/my-books');
  assert.equal(document.querySelector('#location').textContent, '/my-books');

  const updateWtrBtn = [...document.querySelectorAll('button')].find(
    b => b.textContent.trim() === `Update reading for ${bookWtr.title}`
  );
  assert.ok(updateWtrBtn, 'Update reading button exists for book-wtr');
  await act(async () => updateWtrBtn.click());

  const wtrSelect = document.querySelector('.reading-form select');
  assert.ok(wtrSelect, 'reading-form select rendered');
  await changeSelect(wtrSelect, 'read');

  const submitWtrBtn = document.querySelector('.reading-form button[type="submit"]');
  await act(async () => submitWtrBtn.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

  assert.equal(
    document.querySelector('#location').textContent,
    '/books/book-wtr#review',
    'Want to Read -> Read navigates to /books/book-wtr#review'
  );

  // 3. Read -> Read finish-date edit does NOT navigate
  await renderMyBooks('/my-books');
  assert.equal(document.querySelector('#location').textContent, '/my-books');

  const updateReadBtn = [...document.querySelectorAll('button')].find(
    b => b.textContent.trim() === `Update reading for ${bookRead.title}`
  );
  assert.ok(updateReadBtn, 'Update reading button exists for book-read');
  await act(async () => updateReadBtn.click());

  const dateInput = document.querySelector('.reading-form input[type="date"]');
  assert.ok(dateInput, 'Date finished input rendered for read book');
  await changeInput(dateInput, '2026-09-05');

  const submitReadBtn = document.querySelector('.reading-form button[type="submit"]');
  await act(async () => submitReadBtn.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

  assert.equal(
    document.querySelector('#location').textContent,
    '/my-books',
    'Read -> Read finish-date edit stays on /my-books'
  );
  assert.ok(
    document.querySelector('.success-notice')?.textContent.includes('Your bookshelf has been updated.'),
    'Success notice is displayed'
  );

  // 4. Currently Reading -> Currently Reading does NOT navigate
  // First set bookCr back to currently_reading in memory
  shelfMap.get('book-cr').status = 'currently_reading';
  await renderMyBooks('/my-books');
  assert.equal(document.querySelector('#location').textContent, '/my-books');

  const updateCrAgainBtn = [...document.querySelectorAll('button')].find(
    b => b.textContent.trim() === `Update reading for ${bookCr.title}`
  );
  await act(async () => updateCrAgainBtn.click());

  const submitCrAgainBtn = document.querySelector('.reading-form button[type="submit"]');
  await act(async () => submitCrAgainBtn.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

  assert.equal(
    document.querySelector('#location').textContent,
    '/my-books',
    'Currently Reading -> Currently Reading stays on /my-books'
  );

  // 5. shelf removal still behaves as before
  await renderMyBooks('/my-books');
  assert.equal(document.querySelector('#location').textContent, '/my-books');

  const updateRemBtn = [...document.querySelectorAll('button')].find(
    b => b.textContent.trim() === `Update reading for ${bookRem.title}`
  );
  assert.ok(updateRemBtn, 'Update reading button exists for book-rem');
  await act(async () => updateRemBtn.click());

  const removeBtn = [...document.querySelectorAll('button')].find(
    b => b.textContent.trim() === 'Remove from My Books'
  );
  assert.ok(removeBtn, 'Remove from My Books button exists');
  await act(async () => removeBtn.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

  assert.equal(
    document.querySelector('#location').textContent,
    '/my-books',
    'Shelf removal stays on /my-books'
  );
  assert.ok(
    !document.body.textContent.includes(bookRem.title),
    'Removable book is optimistically removed from the page'
  );
  assert.ok(removedIds.has('book-rem'), 'DELETE request was sent for removable book');
});
