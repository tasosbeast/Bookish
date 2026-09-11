import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('reading flow shelf management and rating/review separation', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173' });
  dom.window.confirm = () => true;
  
  let scrolledElements = [];
  dom.window.Element.prototype.scrollIntoView = function(options) {
    scrolledElements.push({ id: this.id, options });
  };

  const original = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true
  })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(navigator, 'locks', { value: { request: (_key, _options, run) => run() } });
  
  const nativeFetch = globalThis.fetch;
  let server, root, session;
  const { createElement: h, act } = await import('react');

  t.after(async () => {
    if (root) await act(async () => root.unmount());
    session?.destroy();
    await server?.close();
    dom.window.close();
    globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });

  const bookId = 'book-flow';
  const stamp = '2026-09-06T10:00:00.000Z';
  let user = { id: 'reader-flow', username: 'reader' };
  let personal = {
    bookId,
    shelf: { status: 'currently_reading', userRating: 4, updatedAt: stamp },
    review: null
  };
  let failPost = false;
  let writes = [];

  const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
  
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') {
      return response({ user, accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`, expiresIn: 900 });
    }
    if (url.pathname.startsWith('/api/user-books/')) {
      return response({ data: personal });
    }
    if (url.pathname === '/api/user-books' && options.method === 'POST') {
      if (failPost) {
        return response({ error: { code: 'UNAVAILABLE', message: 'Failed save' } }, 500);
      }
      const body = JSON.parse(options.body);
      writes.push(body);
      personal = {
        ...personal,
        shelf: { ...personal.shelf, status: body.status, updatedAt: 'updated' }
      };
      return response({ data: personal.shelf });
    }
    return response({
      data: {
        id: bookId, title: 'Flow Book', author: 'Flow Author', genres: [], averageRating: 4,
        reviews: { data: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 1 } }
      }
    });
  };

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }
  });

  const { default: BookDetails } = await server.ssrLoadModule('/src/pages/BookDetails.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, Routes, Route } = await import('react-router-dom');

  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));

  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: [`/books/${bookId}`] },
      h(Routes, null, h(Route, { path: '/books/:id', element: h(BookDetails) }))
    )
  ));

  const click = async buttonText => act(async () => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(buttonText));
    assert.ok(button, `button ${buttonText} exists`);
    button.click();
  });

  const changeSelect = async (selectElement, value) => act(async () => {
    const prototype = dom.window.HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(selectElement, value);
    selectElement.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });

  // 1. Reading Journey no longer renders "Your rating"
  const shelfFormText = document.querySelector('.reading-form').textContent;
  assert.equal(shelfFormText.includes('Your rating'), false, 'ShelfForm must not render Your rating');

  // 2. ReviewForm initializes rating from personal.shelf.userRating when review is null
  const reviewRatingSelect = document.querySelector('.review-form select');
  assert.equal(reviewRatingSelect.value, '4', 'ReviewForm rating should initialize from personal.shelf.userRating');

  // 3. changing status currently_reading -> want_to_read: save sends status but not userRating, does NOT scroll to #review
  scrolledElements = [];
  writes = [];
  const statusSelect = document.querySelector('.reading-form select');
  await changeSelect(statusSelect, 'want_to_read');
  await click('Save changes');
  
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { bookId, status: 'want_to_read' });
  assert.equal(writes[0].userRating, undefined, 'shelf save must not send userRating');
  assert.equal(personal.shelf.userRating, 4, 'userRating preserved in personal shelf');
  assert.equal(scrolledElements.length, 0, 'want_to_read should not scroll to #review');

  // 4. transitioning currently_reading / want_to_read -> read with successful API save: smooth-scrolls to #review
  scrolledElements = [];
  writes = [];
  await changeSelect(statusSelect, 'read');
  await click('Save changes');

  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'read');
  assert.equal(scrolledElements.length, 1, 'transitioning to read must scroll to #review');
  assert.equal(scrolledElements[0].id, 'review');
  assert.deepEqual(scrolledElements[0].options, { behavior: 'smooth' });

  // 5. saving read -> read again: does NOT scroll to #review
  scrolledElements = [];
  writes = [];
  await click('Save changes');

  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'read');
  assert.equal(scrolledElements.length, 0, 'read -> read should not scroll to #review');

  // 6. failed save to read does NOT scroll
  failPost = true;
  scrolledElements = [];
  writes = [];
  await changeSelect(statusSelect, 'currently_reading');
  await click('Save changes'); // will fail
  assert.equal(scrolledElements.length, 0, 'failed save must not scroll');
  failPost = false;
});
