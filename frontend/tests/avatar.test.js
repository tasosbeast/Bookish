import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Avatar renders allowlisted https pictures and falls back otherwise', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/' });
  const original = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const nativeFetch = globalThis.fetch;
  let server, root;
  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    await server?.close();
    dom.window.close();
    globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { Avatar } = await server.ssrLoadModule('/src/components/Avatar.jsx');
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  root = createRoot(document.getElementById('root'));

  const render = async props => {
    await act(async () => { root.render(h(Avatar, props)); });
  };

  await render({ username: 'Maria', profilePicture: '  https://www.gravatar.com/avatar/abc?d=identicon  ' });
  const allowed = document.querySelector('img.reader-avatar');
  assert.equal(allowed.getAttribute('src'), 'https://www.gravatar.com/avatar/abc?d=identicon');
  assert.equal(allowed.alt, "Maria's avatar");
  assert.equal(allowed.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(allowed.getAttribute('loading'), 'lazy');

  await act(async () => {
    allowed.dispatchEvent(new dom.window.Event('error'));
  });
  assert.equal(document.querySelector('img'), null, 'a failed image load uses the default avatar');
  assert.equal(document.querySelector('.reader-avatar-placeholder').textContent, 'M');

  for (const profilePicture of [
    null,
    '',
    'http://www.gravatar.com/avatar/abc',
    'https://evil.example/pixel.png',
    'https://www.gravatar.com/avatar/abc?d=https://evil.example/pixel.png',
    'https://gravatar.com.evil.example/avatar/abc',
    'https://x.bc.googleusercontent.com/a',
    'https://abc-colab.googleusercontent.com/a',
    'https://www.gravatar.com/photo/abc',
    'https://www.gravatar.com./avatar/abc',
  ]) {
    await render({ username: 'alex', profilePicture });
    assert.equal(document.querySelector('img'), null, `no image for ${profilePicture}`);
    assert.equal(document.querySelector('.reader-avatar-placeholder').textContent, 'A');
  }

  await render({
    username: 'reader',
    profilePicture: 'https://lh3.googleusercontent.com/a/photo',
    className: 'account-avatar',
    placeholderClassName: 'account-avatar',
    alt: "reader's profile picture",
  });
  const accountAvatar = document.querySelector('img.account-avatar');
  assert.equal(accountAvatar.getAttribute('src'), 'https://lh3.googleusercontent.com/a/photo');
  assert.equal(accountAvatar.alt, "reader's profile picture");
  assert.equal(accountAvatar.getAttribute('referrerpolicy'), 'no-referrer');
});