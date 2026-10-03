import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { isAllowedAvatarUrl } from '../src/lib/avatarUrl.js';

const legacyPicture = 'https://images.example/legacy-avatar.jpg';
const validPicture = 'https://lh3.googleusercontent.com/a/new-avatar';

test('legacy profile picture does not block other account edits', { timeout: 60000 }, async t => {
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
    profilePicture: legacyPicture,
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
      if (body.profilePicture !== undefined && body.profilePicture.trim() !== '' && !isAllowedAvatarUrl(body.profilePicture.trim())) {
        return Response.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid input',
            details: [{ field: 'body.profilePicture', message: 'Must be an https URL on an allowed host' }],
          },
        }, { status: 400 });
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

  const edit = async () => {
    const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Edit profile');
    assert.ok(button, 'Edit profile button should exist');
    await act(async () => button.click());
  };
  const submit = async () => {
    const form = document.querySelector('form');
    await act(async () => {
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };

  assert.equal(document.querySelector('img.account-avatar'), null);
  assert.equal(document.querySelector('span.account-avatar').textContent, 'R');

  await edit();
  await act(async () => setInputValue(document.querySelector('textarea[name="bio"]'), 'Updated bio'));
  assert.equal(document.querySelector('input[name="profilePicture"]').value, legacyPicture);
  await submit();

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { bio: 'Updated bio' });
  assert.equal('profilePicture' in requests[0].body, false);
  assert.ok(document.body.textContent.includes('Updated bio'));
  assert.equal(document.querySelector('img.account-avatar'), null);
  assert.equal(document.querySelector('textarea[name="bio"]'), null, 'Successful bio save closes the form');

  await edit();
  assert.equal(document.querySelector('input[name="profilePicture"]').value, legacyPicture);
  await act(async () => setInputValue(document.querySelector('input[name="profilePicture"]'), 'https://evil.example/pixel.png'));
  await submit();

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body, { bio: 'Updated bio', profilePicture: 'https://evil.example/pixel.png' });
  assert.ok(document.querySelector('.error-notice').textContent.includes('profilePicture: Must be an https URL on an allowed host'));
  assert.ok(document.querySelector('textarea[name="bio"]'), 'Invalid picture leaves the form open');
  assert.equal(document.querySelector('img.account-avatar'), null);
  assert.equal(document.querySelector('input[name="profilePicture"]').value, 'https://evil.example/pixel.png');

  await act(async () => setInputValue(document.querySelector('input[name="profilePicture"]'), ''));
  await submit();

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].body, { bio: 'Updated bio', profilePicture: '' });
  assert.equal(document.querySelector('.error-notice'), null);
  assert.equal(document.querySelector('img.account-avatar'), null);
  assert.equal(document.querySelector('span.account-avatar').textContent, 'R');

  currentUser = { ...currentUser, profilePicture: legacyPicture };
  await act(async () => session.updateUser(currentUser));
  await edit();
  assert.equal(document.querySelector('input[name="profilePicture"]').value, legacyPicture);
  await act(async () => setInputValue(document.querySelector('input[name="profilePicture"]'), validPicture));
  await submit();

  assert.equal(requests.length, 4);
  assert.deepEqual(requests[3].body, { bio: 'Updated bio', profilePicture: validPicture });
  const savedAvatar = document.querySelector('img.account-avatar');
  assert.equal(savedAvatar.getAttribute('src'), validPicture);
  assert.equal(savedAvatar.getAttribute('referrerpolicy'), 'no-referrer');

  currentUser = { ...currentUser, profilePicture: legacyPicture };
  await act(async () => session.updateUser(currentUser));
  await edit();
  assert.equal(document.querySelector('input[name="profilePicture"]').value, legacyPicture);
  const newerPicture = 'https://lh4.googleusercontent.com/a/newer-from-another-device';
  currentUser = { ...currentUser, profilePicture: newerPicture };
  await act(async () => session.updateUser(currentUser));
  assert.equal(document.querySelector('input[name="profilePicture"]').value, legacyPicture, 'the open draft keeps the picture from when editing started');
  await act(async () => setInputValue(document.querySelector('textarea[name="bio"]'), 'Bio while the picture changed elsewhere'));
  await submit();

  assert.equal(requests.length, 5);
  assert.deepEqual(requests[4].body, { bio: 'Bio while the picture changed elsewhere' });
  assert.equal('profilePicture' in requests[4].body, false, 'an untouched picture is not sent when the session user changes');
  assert.equal(document.querySelector('textarea[name="bio"]'), null, 'omitting the untouched picture still saves');
  assert.equal(document.querySelector('img.account-avatar').getAttribute('src'), newerPicture);

  const paddedPicture = `  ${newerPicture} `;
  currentUser = { ...currentUser, profilePicture: paddedPicture };
  await act(async () => session.updateUser(currentUser));
  await edit();
  await act(async () => {
    setInputValue(document.querySelector('textarea[name="bio"]'), 'Whitespace picture');
    setInputValue(document.querySelector('input[name="profilePicture"]'), paddedPicture);
  });
  await submit();

  assert.equal(requests.length, 6);
  assert.deepEqual(requests[5].body, { bio: 'Whitespace picture' });
  assert.equal('profilePicture' in requests[5].body, false, 'a padded stored picture is unchanged after the URL input strips it');
});
