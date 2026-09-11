import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('profile editing flow in Account component', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/account' });
  dom.window.scrollTo = () => {};
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
    const proto = el.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    valueSetter.call(el, val);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };

  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    session?.destroy(); await server?.close(); dom.window.close(); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });

  let currentUser = {
    id: 'internal-user-id',
    username: 'reader',
    email: 'reader@example.com',
    profilePicture: 'https://images.example/profile.jpg',
    bio: 'Initial bio'
  };

  const requests = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') {
      return Response.json({
        user: currentUser,
        accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`,
        expiresIn: 900
      });
    }
    if (url.pathname === '/api/auth/me' && init.method === 'PATCH') {
      const body = JSON.parse(init.body || '{}');
      requests.push({ method: 'PATCH', body });
      if (body.bio === 'TRIGGER_ERROR') {
        return Response.json({ error: { code: 'BAD_REQUEST', message: 'Invalid bio string' } }, { status: 400 });
      }
      const updated = {
        ...currentUser,
        ...(body.bio !== undefined && { bio: body.bio === '' ? null : body.bio }),
        ...(body.profilePicture !== undefined && { profilePicture: body.profilePicture === '' ? null : body.profilePicture })
      };
      currentUser = updated;
      return Response.json({ user: updated });
    }
    return Response.json({ data: [], pagination: { page: 1, limit: 18, total: 0, totalPages: 0 } });
  };

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] }
  });
  const { default: App } = await server.ssrLoadModule('/src/App.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');

  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(App)));

  // Verify initial read state
  assert.ok(document.body.textContent.includes('Initial bio'));
  assert.equal(document.querySelector('input[name="username"]'), null, 'Username must remain read-only');
  assert.equal(document.querySelector('input[name="email"]'), null, 'Email must remain read-only');

  // Open edit mode
  const editBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Edit profile');
  assert.ok(editBtn, 'Edit profile button should exist');
  await act(async () => editBtn.click());

  // Edit profile opens with current values
  const bioInput = document.querySelector('textarea[name="bio"]');
  const picInput = document.querySelector('input[name="profilePicture"]');
  assert.equal(bioInput.value, 'Initial bio');
  assert.equal(picInput.value, 'https://images.example/profile.jpg');
  assert.equal(document.querySelector('input[name="username"]'), null, 'Username input does not exist in edit form');
  assert.equal(document.querySelector('input[name="email"]'), null, 'Email input does not exist in edit form');

  // Cancel makes no request
  const cancelBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
  await act(async () => cancelBtn.click());
  assert.equal(requests.length, 0, 'Cancel should make no HTTP request');
  assert.ok(document.body.textContent.includes('Initial bio'));

  // Open edit again, change values, submit
  const editBtn2 = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Edit profile');
  await act(async () => editBtn2.click());

  const bioInput2 = document.querySelector('textarea[name="bio"]');
  const picInput2 = document.querySelector('input[name="profilePicture"]');
  const form = document.querySelector('form');

  await act(async () => {
    setInputValue(bioInput2, 'Updated bio text');
    setInputValue(picInput2, 'https://images.example/new-avatar.png');
  });

  await act(async () => {
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });

  // Save sends intended PATCH body
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { bio: 'Updated bio text', profilePicture: 'https://images.example/new-avatar.png' });

  // Successful save updates displayed bio/avatar immediately without reload
  assert.ok(document.body.textContent.includes('Updated bio text'));
  assert.equal(document.querySelector('.account-avatar').src, 'https://images.example/new-avatar.png');

  // Clearing values works
  const editBtn3 = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Edit profile');
  await act(async () => editBtn3.click());

  const bioInput3 = document.querySelector('textarea[name="bio"]');
  const picInput3 = document.querySelector('input[name="profilePicture"]');
  const form3 = document.querySelector('form');

  await act(async () => {
    setInputValue(bioInput3, '');
    setInputValue(picInput3, '');
  });

  await act(async () => {
    form3.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body, { bio: '', profilePicture: '' });
  assert.ok(document.body.textContent.includes('No bio added yet.'));
  assert.equal(document.querySelector('img.account-avatar'), null);
  assert.equal(document.querySelector('span.account-avatar').textContent, 'R');

  // API failure leaves form editable and shows error
  const editBtn4 = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Edit profile');
  await act(async () => editBtn4.click());

  const bioInput4 = document.querySelector('textarea[name="bio"]');
  const form4 = document.querySelector('form');

  await act(async () => {
    setInputValue(bioInput4, 'TRIGGER_ERROR');
  });

  await act(async () => {
    form4.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });

  assert.ok(document.body.textContent.includes('Invalid bio string'), 'Error message should be shown on failure');
  assert.ok(document.querySelector('textarea[name="bio"]'), 'Form should remain open and editable after failure');
});
