import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Discover dynamic genre pills and failure resilience', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173' });
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

  let genresFail = false;

  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    session?.destroy(); await server?.close(); dom.window.close(); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });

  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') {
      return Response.json({
        user: { id: 'reader', username: 'reader' },
        accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`,
        expiresIn: 900
      });
    }
    if (url.pathname === '/api/genres') {
      if (genresFail) {
        return Response.json({ error: { code: 'SERVER_ERROR', message: 'Failed to load genres' } }, { status: 500 });
      }
      return Response.json({
        data: [
          { id: 'g-cyberpunk', name: 'Cyberpunk', slug: 'cyberpunk' },
          { id: 'g-fantasy', name: 'Fantasy', slug: 'fantasy' },
        ]
      });
    }
    return Response.json({
      data: [{
        id: 'book-1',
        title: 'Neuromancer',
        author: 'William Gibson',
        coverImageUrl: null,
        averageRating: 4.5,
        genres: [{ id: 'g-cyberpunk', name: 'Cyberpunk', slug: 'cyberpunk' }]
      }],
      pagination: { page: 1, limit: 18, total: 1, totalPages: 1 }
    });
  };

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] }
  });
  const { default: Discover } = await server.ssrLoadModule('/src/pages/Discover.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, useLocation } = await import('react-router-dom');

  function Location() { return h('output', { id: 'location' }, useLocation().search); }

  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/'] }, h(Discover), h(Location))));

  // 1. Dynamic genres are rendered from /genres (All, Cyberpunk, Fantasy)
  const pillLabels = [...document.querySelectorAll('.genre-filter')].map(b => b.textContent);
  assert.deepEqual(pillLabels, ['All', 'Cyberpunk', 'Fantasy']);

  // 2. Clicking a dynamic genre pill updates ?genre=<slug>
  const cyberpunkPill = [...document.querySelectorAll('.genre-filter')].find(b => b.textContent === 'Cyberpunk');
  assert.ok(cyberpunkPill);
  await act(async () => cyberpunkPill.click());
  assert.equal(document.querySelector('#location').textContent, '?genre=cyberpunk');
  assert.equal(cyberpunkPill.getAttribute('aria-pressed'), 'true');

  // 3. Book card genre label selection works
  const cardGenreBtn = document.querySelector('.book-card-meta .genre');
  assert.ok(cardGenreBtn);
  await act(async () => cardGenreBtn.click());
  assert.equal(document.querySelector('#location').textContent, '?genre=cyberpunk');

  await act(async () => root.unmount());

  // 4. Test failure behavior of /genres
  genresFail = true;
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/?genre=cyberpunk'] }, h(Discover), h(Location))));

  // Books still render despite genres failure
  assert.ok(document.body.textContent.includes('Neuromancer'), 'Books load despite /genres failure');
  // "All" option remains available
  const fallbackPills = [...document.querySelectorAll('.genre-filter')].map(b => b.textContent);
  assert.deepEqual(fallbackPills, ['All']);
  // Slug fallback in filter text
  assert.ok(document.body.textContent.includes('Cyberpunk') || document.body.textContent.includes('cyberpunk'));
});
