import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Top Picks frontend: rendering rules, states, filters, and error isolation', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173' });
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
  const requests = [];

  const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

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

  let topPicksResponseData = {
    data: [
      {
        id: 'rec-1',
        title: 'Recommended Book 1',
        author: 'Top Author',
        coverImageUrl: null,
        averageRating: 4.5,
        genres: [{ id: 'g1', name: 'Thriller', slug: 'thriller' }],
        reason: { type: 'author', label: 'Top Author' },
      },
      {
        id: 'rec-2',
        title: 'Recommended Book 2',
        author: 'Another Author',
        coverImageUrl: null,
        averageRating: 4.2,
        genres: [{ id: 'g1', name: 'Thriller', slug: 'thriller' }],
        reason: { type: 'genre', label: 'Thriller' },
      },
    ],
    meta: { personalized: true, ratedBooks: 5, minimumRatings: 3 },
  };

  let topPicksError = false;

  globalThis.fetch = input => {
    const url = new URL(input);
    requests.push(url.toString());

    if (url.pathname === '/api/auth/login') {
      return Promise.resolve(jsonResponse({
        user: { id: 'reader-1', username: 'reader' },
        accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`,
        expiresIn: 900,
      }));
    }
    if (url.pathname === '/api/genres') {
      return Promise.resolve(jsonResponse({ data: [{ id: 'g1', name: 'Thriller', slug: 'thriller' }] }));
    }
    if (url.pathname === '/api/recommendations/top-picks') {
      if (topPicksError) {
        return Promise.resolve(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Failed to compute top picks' } }, 500));
      }
      return Promise.resolve(jsonResponse(topPicksResponseData));
    }
    if (url.pathname === '/api/books') {
      return Promise.resolve(jsonResponse({
        data: [{ id: 'cat-1', title: 'Catalog Book 1', author: 'Catalog Author', coverImageUrl: null, averageRating: 4.0, genres: [] }],
        pagination: { page: 1, limit: 18, total: 1, totalPages: 1 },
      }));
    }
    return Promise.resolve(jsonResponse({ data: [] }));
  };

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  const { default: Discover } = await server.ssrLoadModule('/src/pages/Discover.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, Routes, Route } = await import('react-router-dom');

  root = createRoot(document.getElementById('root'));

  // 1. Anonymous Discover has no Top Picks section and does NOT fetch recommendations
  requests.length = 0;
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));
  assert.equal(document.querySelector('.top-picks-section'), null, 'Anonymous Discover does not render Top Picks section');
  assert.ok(!requests.some(r => r.includes('/recommendations/top-picks')), 'Anonymous Discover does not fetch top-picks');

  // Authenticate user
  await session.authenticate('login', {});

  // 2. Authenticated unfiltered page 1 fetches and shows Top Picks section with recommendations & reasons
  requests.length = 0;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));

  assert.ok(requests.some(r => r.includes('/recommendations/top-picks')), 'Authenticated page 1 fetches top-picks');
  assert.ok(document.querySelector('.top-picks-section'), 'Renders Top Picks section');
  assert.ok(document.body.textContent.includes('Recommended Book 1'));
  assert.ok(document.body.textContent.includes("Because you've enjoyed books by Top Author"));
  assert.ok(document.body.textContent.includes('Because you often rate Thriller highly'));

  // Click recommendation links to /books/rec-1
  const recLink = document.querySelector('a[href="/books/rec-1"]');
  assert.ok(recLink, 'Recommendation item links to /books/rec-1');

  // 3. Search / Filter active -> Top Picks section is NOT rendered and not fetched
  requests.length = 0;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/?genre=thriller'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));

  assert.equal(document.querySelector('.top-picks-section'), null, 'Filtered Discover (genre) does not render Top Picks');
  assert.ok(!requests.some(r => r.includes('/recommendations/top-picks')), 'Filtered Discover does not fetch top-picks');

  // 4. Page > 1 -> Top Picks section is NOT rendered
  requests.length = 0;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/?page=2'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));

  assert.equal(document.querySelector('.top-picks-section'), null, 'Page 2 Discover does not render Top Picks');

  // 5. Insufficient ratings state (meta.personalized === false)
  topPicksResponseData = {
    data: [],
    meta: { personalized: false, ratedBooks: 1, minimumRatings: 3 },
  };

  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));

  assert.ok(document.querySelector('.top-picks-section'), 'Renders Top Picks section for insufficient ratings');
  assert.ok(document.body.textContent.includes("Rate at least 3 books you've read and we'll start learning your taste."));
  const myBooksBtn = document.querySelector('a[href="/my-books"]');
  assert.ok(myBooksBtn, 'Contains button linking to /my-books');

  // 6. Top Picks API failure does not break normal Discover catalog
  topPicksError = true;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));

  assert.ok(document.querySelector('.top-picks-section .error-notice'), 'Renders local error notice in Top Picks');
  assert.ok(document.body.textContent.includes('Catalog Book 1'), 'Normal catalog continues to display despite Top Picks error');
});
