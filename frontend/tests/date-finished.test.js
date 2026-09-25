import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Date finished frontend: visibility, defaulting, editing, future constraint, and form isolation', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173' });
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

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }
  });

  let apiCalls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') {
      return new Response(JSON.stringify({
        user: { id: 'test-user', username: 'tester' },
        accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`,
        expiresIn: 900,
      }), { status: 200 });
    }
    if (url.pathname === '/api/user-books' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      apiCalls.push(body);
      return new Response(JSON.stringify({ data: { ...body } }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const { ShelfForm, ReviewForm } = await server.ssrLoadModule('/src/components/ReadingForms.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createRoot } = await import('react-dom/client');

  await session.authenticate('login', {});

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

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

  const click = async buttonSelector => act(async () => {
    const button = document.querySelector(buttonSelector);
    assert.ok(button, `button ${buttonSelector} exists`);
    button.click();
  });

  // Case 22: Date finished hidden for Want to Read
  root = createRoot(document.getElementById('root'));
  let savedCalls = [];
  const personalWant = { bookId: 'b-want', shelf: { status: 'want_to_read' }, review: null };
  await act(async () => root.render(h(ShelfForm, { personal: personalWant, onSaved: msg => savedCalls.push(msg) })));
  assert.equal(document.querySelector('input[type="date"]'), null, 'Date finished hidden for Want to Read');

  // Case 23: Date finished hidden for Currently Reading
  const personalCurrent = { bookId: 'b-curr', shelf: { status: 'currently_reading' }, review: null };
  await act(async () => root.render(h(ShelfForm, { personal: personalCurrent, onSaved: msg => savedCalls.push(msg) })));
  assert.equal(document.querySelector('input[type="date"]'), null, 'Date finished hidden for Currently Reading');

  // Case 24 & 26: shown for Read, preloads saved finishedOn
  const personalRead = { bookId: 'b-read', shelf: { status: 'read', finishedOn: '2026-09-05' }, review: null };
  await act(async () => root.render(h(ShelfForm, { personal: personalRead, onSaved: msg => savedCalls.push(msg) })));
  const dateInput = document.querySelector('input[type="date"]');
  assert.ok(dateInput, 'Date finished shown for Read');
  assert.equal(dateInput.value, '2026-09-05', 'Existing Read book preloads saved finishedOn');

  // Case 28: Future dates blocked by input max
  assert.equal(dateInput.max, todayStr, 'Date finished input has max attribute set to today local date');

  // Case 25: First transition to Read defaults date input to today
  await act(async () => root.render(h(ShelfForm, { personal: personalWant, onSaved: msg => savedCalls.push(msg) })));
  const statusSelect = document.querySelector('.reading-form select');
  await changeSelect(statusSelect, 'read');
  const transitionedDateInput = document.querySelector('input[type="date"]');
  assert.ok(transitionedDateInput, 'Date input appears upon transitioning to Read');
  assert.equal(transitionedDateInput.value, todayStr, 'Transitioning to Read defaults to today');

  // Case 27: Edited date is sent to API
  apiCalls.length = 0;

  await act(async () => root.render(h(ShelfForm, { personal: personalRead, onSaved: msg => savedCalls.push(msg) })));
  const readDateInput = document.querySelector('input[type="date"]');
  await changeInput(readDateInput, '2026-08-20');
  await click('.reading-actions button[type="submit"]');

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].bookId, 'b-read');
  assert.equal(apiCalls[0].status, 'read');
  assert.equal(apiCalls[0].finishedOn, '2026-08-20', 'Edited date is sent in save request');
  assert.equal(apiCalls[0].userRating, undefined, 'Date-only save with unchanged rating omits userRating');

  // Case 29: Changing date does not disturb rating/review forms
  let reviewText = 'Initial thoughts';
  let reviewRating = '4';
  const personalCombined = {
    bookId: 'b-comb',
    shelf: { status: 'read', finishedOn: '2026-09-01', userRating: 4 },
    review: { id: 'r-1', rating: 4, reviewText: 'Initial thoughts' },
  };

  function CombinedComponent() {
    return h('div', null,
      h(ShelfForm, { personal: personalCombined, onSaved: () => {} }),
      h(ReviewForm, { personal: personalCombined, onSaved: () => {} })
    );
  }

  await act(async () => root.render(h(CombinedComponent)));

  const dateInp = document.querySelector('.reading-form input[type="date"]');
  const ratingSel = document.querySelector('.review-form select.review-rating');
  const textarea = document.querySelector('.review-form textarea');

  assert.equal(ratingSel.value, '4');
  assert.equal(textarea.value, 'Initial thoughts');

  // Edit date in ShelfForm
  await changeInput(dateInp, '2026-08-15');

  // Verify review form remains untouched
  assert.equal(ratingSel.value, '4', 'Rating select unaffected by date change');
  assert.equal(textarea.value, 'Initial thoughts', 'Review textarea unaffected by date change');
});
