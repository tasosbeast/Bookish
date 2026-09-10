import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Footer contains the Send feedback link', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/' });
  const original = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(navigator, 'locks', { value: { request: (_key, _options, work) => work() } });
  
  // Mock window.scrollTo since JSDOM doesn't implement it
  globalThis.window.scrollTo = () => {};

  const nativeFetch = globalThis.fetch;
  let server, root, session;

  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    session?.destroy(); await server?.close(); dom.window.close(); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });

  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/api/books') return Response.json({ data: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } });
    return Response.json({});
  };

  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const { default: App } = await server.ssrLoadModule('/src/App.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');

  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(App)));

  const feedbackLink = [...document.querySelectorAll('.site-footer a')].find(a => a.textContent === 'Send feedback');
  assert.ok(feedbackLink, 'Send feedback link should be present in the footer');
  assert.match(feedbackLink.getAttribute('href'), /docs\.google\.com\/forms/);
  assert.equal(feedbackLink.getAttribute('target'), '_blank');
  assert.equal(feedbackLink.getAttribute('rel'), 'noopener noreferrer');
});
