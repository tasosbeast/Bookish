import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Releases frontend: routing, navigation, rendering, exact date labels, book links, empty states, failure and tabs', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/releases' });
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
  globalThis.window.scrollTo = () => {};
  const nativeFetch = globalThis.fetch;
  let server, root, session;

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

  let releasesApiResponse = {
    asOf: '2026-09-15',
    windows: {
      newReleases: { from: '2026-06-17', to: '2026-09-15' },
      upcoming: { fromExclusive: '2026-09-15', to: '2027-03-14' },
    },
    newReleases: [
      {
        id: 'book-new-1',
        title: 'The Autumn Story',
        author: 'Jane Author',
        isbn: '9781111111111',
        coverImageUrl: null,
        publicationYear: 2026,
        publicationDate: '2026-09-05',
        averageRating: 4.5,
        genres: [{ id: 'g1', name: 'Fiction', slug: 'fiction' }],
      },
    ],
    upcoming: [
      {
        id: 'book-up-1',
        title: 'The Winter Horizon',
        author: 'John Writer',
        isbn: '9782222222222',
        coverImageUrl: null,
        publicationYear: 2026,
        publicationDate: '2026-09-24',
        averageRating: null,
        genres: [{ id: 'g2', name: 'Sci-Fi', slug: 'sci-fi' }],
      },
    ],
  };

  let releasesApiError = false;

  globalThis.fetch = (input) => {
    const url = new URL(input);

    if (url.pathname === '/api/auth/refresh' || url.pathname === '/api/auth/me') {
      return Promise.resolve(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401));
    }
    if (url.pathname === '/api/genres') {
      return Promise.resolve(jsonResponse({ data: [] }));
    }
    if (url.pathname === '/api/releases') {
      if (releasesApiError) {
        return Promise.resolve(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load releases' } }, 500));
      }
      return Promise.resolve(jsonResponse(releasesApiResponse));
    }
    return Promise.resolve(jsonResponse({ data: [] }));
  };

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { default: Layout } = await server.ssrLoadModule('/src/components/Layout.jsx');
  const { default: Releases, formatReleaseDate } = await server.ssrLoadModule('/src/pages/Releases.jsx');
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, Routes, Route } = await import('react-router-dom');

  // Test 4 helper: date formatting unit
  assert.equal(formatReleaseDate('2026-09-05', 'new'), 'Released Sep 5, 2026');
  assert.equal(formatReleaseDate('2026-09-24', 'upcoming'), 'Coming Sep 24, 2026');
  assert.equal(formatReleaseDate('2027-01-01', 'upcoming'), 'Coming Jan 1, 2027');

  // Initialize session as guest
  await session.initialize();

  root = createRoot(document.getElementById('root'));

  // 1. Initial Render with Data
  await act(async () => {
    root.render(
      h(MemoryRouter, { initialEntries: ['/releases'] },
        h(Routes, null,
          h(Route, { element: h(Layout) },
            h(Route, { path: 'releases', element: h(Releases) }),
            h(Route, { path: 'books/:id', element: h('div', { id: 'book-details-view' }, 'Book Details Page') })
          )
        )
      )
    );
  });

  // 1. /releases renders with page title
  assert.ok(document.body.textContent.includes('Releases'));
  assert.ok(document.querySelector('.releases-page'));

  // 8. Navigation link removed from main nav in Layout
  const releasesNav = [...document.querySelectorAll('.main-nav a')].find(a => a.textContent === 'Releases');
  assert.equal(releasesNav, undefined, 'Navigation link for Releases does not exist in main nav');

  // 2 & 3. New Releases and Upcoming sections render returned books
  assert.ok(document.body.textContent.includes('The Autumn Story'), 'New release book rendered');
  assert.ok(document.body.textContent.includes('The Winter Horizon'), 'Upcoming book rendered');
  assert.ok(document.body.textContent.includes('Jane Author'));
  assert.ok(document.body.textContent.includes('John Writer'));

  // 4. Exact release-date labels render
  assert.ok(document.body.textContent.includes('Released Sep 5, 2026'), 'New release date label rendered');
  assert.ok(document.body.textContent.includes('Coming Sep 24, 2026'), 'Upcoming date label rendered');

  // 5. Clicking a release book navigates to /books/:id
  const bookLink = [...document.querySelectorAll('a')].find(a => a.getAttribute('href') === '/books/book-new-1');
  assert.ok(bookLink, 'Link to /books/book-new-1 exists');

  // 9. Tab switching (All -> New Releases -> Upcoming)
  const tabButtons = [...document.querySelectorAll('.release-tabs button')];
  const newTab = tabButtons.find(b => b.textContent === 'New Releases');
  const upcomingTab = tabButtons.find(b => b.textContent === 'Upcoming');

  await act(async () => {
    newTab.click();
  });
  assert.ok(document.body.textContent.includes('The Autumn Story'));
  assert.ok(!document.body.textContent.includes('The Winter Horizon'), 'Upcoming section hidden on New tab');

  await act(async () => {
    upcomingTab.click();
  });
  assert.ok(!document.body.textContent.includes('The Autumn Story'), 'New Releases section hidden on Upcoming tab');
  assert.ok(document.body.textContent.includes('The Winter Horizon'));

  // 6. Empty states: Unmount and re-render with empty data
  await act(async () => {
    root.unmount();
  });

  releasesApiResponse = {
    asOf: '2026-09-15',
    windows: {
      newReleases: { from: '2026-06-17', to: '2026-09-15' },
      upcoming: { fromExclusive: '2026-09-15', to: '2027-03-14' },
    },
    newReleases: [],
    upcoming: [],
  };

  root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      h(MemoryRouter, { initialEntries: ['/releases'] },
        h(Routes, null,
          h(Route, { element: h(Layout) },
            h(Route, { path: 'releases', element: h(Releases) })
          )
        )
      )
    );
  });

  assert.ok(document.body.textContent.includes('No recent releases yet.'), 'Empty state for new releases rendered');
  assert.ok(document.body.textContent.includes('No upcoming releases yet.'), 'Empty state for upcoming releases rendered');

  // 7. API failure state and retry: Unmount and re-render with error
  await act(async () => {
    root.unmount();
  });

  releasesApiError = true;
  root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      h(MemoryRouter, { initialEntries: ['/releases'] },
        h(Routes, null,
          h(Route, { element: h(Layout) },
            h(Route, { path: 'releases', element: h(Releases) })
          )
        )
      )
    );
  });

  assert.ok(document.querySelector('[role="alert"]'), 'Error alert rendered on API failure');
  assert.ok(document.body.textContent.includes('Failed to load releases'));
  const retryButton = [...document.querySelectorAll('button')].find(b => b.textContent === 'Try again');
  assert.ok(retryButton, 'Retry button rendered');

  // Click retry after recovering
  releasesApiError = false;
  await act(async () => {
    retryButton.click();
  });
  assert.equal(document.querySelector('[role="alert"]'), null, 'Error notice dismissed on successful retry');
});
