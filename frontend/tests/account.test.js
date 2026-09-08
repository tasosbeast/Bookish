import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('signed-in readers can view only their safe profile fields at the account route', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/account' });
  dom.window.scrollTo = () => {};
  const original = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(navigator, 'locks', { value: { request: (_key, _options, work) => work() } });
  const nativeFetch = globalThis.fetch;
  let server, root, session;
  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    session?.destroy(); await server?.close(); dom.window.close(); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  const user = { id: 'internal-user-id', username: 'reader', email: 'reader@example.com', profilePicture: 'https://images.example/profile.jpg', bio: 'A quiet corner for good books.' };
  globalThis.fetch = async input => {
    if (new URL(input).pathname === '/api/auth/login') return Response.json({ user, accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`, expiresIn: 900 });
    return Response.json({ data: [], pagination: { page: 1, limit: 18, total: 0, totalPages: 0 } });
  };
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const { default: App } = await server.ssrLoadModule('/src/App.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(App)));
  assert.equal(document.querySelector('h1').textContent, 'Reader profile.');
  assert.equal(document.querySelector('.account-identity h2').textContent, user.username);
  assert.ok(document.body.textContent.includes(user.email));
  assert.ok(document.body.textContent.includes(user.bio));
  assert.equal(document.querySelector('.account-avatar').src, user.profilePicture);
  assert.equal(document.querySelector('a[href="/account"]').title, 'View account');
  assert.ok(!document.body.textContent.includes(user.id));
  assert.ok(!document.body.textContent.includes('accessToken'));
});
