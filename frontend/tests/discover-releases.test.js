import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Discover releases integration: order, auth rules, filter hiding, single API call, dates, links, error resilience, empty states', { timeout: 60000 }, async t => {
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
        title: 'Top Pick Title',
        author: 'Top Pick Author',
        coverImageUrl: null,
        averageRating: 4.8,
        genres: [{ id: 'g1', name: 'Thriller', slug: 'thriller' }],
        reason: { type: 'author', label: 'Top Pick Author' },
      },
    ],
    meta: { personalized: true, ratedBooks: 5, minimumRatings: 3 },
  };

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
    requests.push(url.toString());

    if (url.pathname === '/api/auth/refresh' || url.pathname === '/api/auth/me') {
      return Promise.resolve(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401));
    }
    if (url.pathname === '/api/auth/login') {
      return Promise.resolve(jsonResponse({
        user: { id: 'reader-1', username: 'reader' },
        accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`,
        expiresIn: 900,
      }));
    }
    if (url.pathname === '/api/genres') {
      return Promise.resolve(jsonResponse({
        data: [
          { id: 'g1', name: 'Fiction', slug: 'fiction' },
          { id: 'g2', name: 'Sci-Fi', slug: 'sci-fi' },
        ],
      }));
    }
    if (url.pathname === '/api/recommendations/top-picks') {
      return Promise.resolve(jsonResponse(topPicksResponseData));
    }
    if (url.pathname === '/api/releases') {
      if (releasesApiError) {
        return Promise.resolve(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load releases' } }, 500));
      }
      return Promise.resolve(jsonResponse(releasesApiResponse));
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
  const { default: Layout } = await server.ssrLoadModule('/src/components/Layout.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, Routes, Route } = await import('react-router-dom');

  root = createRoot(document.getElementById('root'));

  // Initialize session as guest
  await session.initialize();

  // ============================================================
  // Test 1: Logged-out unfiltered Discover
  // ============================================================
  requests.length = 0;
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null,
        h(Route, { element: h(Layout) },
          h(Route, { path: '/', element: h(Discover) }),
          h(Route, { path: 'releases', element: h('div', { id: 'releases-view' }, 'Releases View') }),
          h(Route, { path: 'books/:id', element: h('div', { id: 'book-details-view' }, 'Book Details View') })
        )
      )
    )
  ));

  // Top Picks absent for logged-out
  assert.equal(document.querySelector('.top-picks-section'), null, 'Top Picks absent for logged-out users');
  // New Releases & Upcoming shown
  assert.ok(document.body.textContent.includes('New Releases'), 'New Releases heading rendered');
  assert.ok(document.body.textContent.includes('Just arrived'), 'New Releases eyebrow rendered');
  assert.ok(document.body.textContent.includes('Upcoming'), 'Upcoming heading rendered');
  assert.ok(document.body.textContent.includes('On the horizon'), 'Upcoming eyebrow rendered');
  assert.ok(document.body.textContent.includes('The Autumn Story'), 'New release book rendered');
  assert.ok(document.body.textContent.includes('The Winter Horizon'), 'Upcoming book rendered');

  // Test 3: Release API called once with limit=8
  const releaseRequests = requests.filter(r => r.includes('/api/releases'));
  assert.equal(releaseRequests.length, 1, 'Release API is called exactly once on initial load');
  assert.ok(releaseRequests[0].includes('limit=8'), 'Release API is queried with limit=8');

  // Test 4: Exact date labels render
  assert.ok(document.body.textContent.includes('Released Sep 5, 2026'), 'Exact released date label rendered');
  assert.ok(document.body.textContent.includes('Coming Sep 24, 2026'), 'Exact upcoming date label rendered');

  // Test 5: "View all" links navigate to /releases
  const viewAllLinks = [...document.querySelectorAll('a')].filter(a => a.textContent === 'View all');
  assert.equal(viewAllLinks.length, 2, 'Two View all links exist in section headings');
  assert.equal(viewAllLinks[0].getAttribute('href'), '/releases');
  assert.equal(viewAllLinks[1].getAttribute('href'), '/releases');

  // Test 6: Releases main-nav link no longer exists
  const mainNavReleases = [...document.querySelectorAll('.main-nav a')].find(a => a.textContent === 'Releases');
  assert.equal(mainNavReleases, undefined, 'Releases link removed from main nav in Layout');

  // Test 15: Clicking release book navigates to /books/:id
  const newBookLink = document.querySelector('a[href="/books/book-new-1"]');
  assert.ok(newBookLink, 'Cover/title link to /books/book-new-1 exists');

  // ============================================================
  // Test 2: Authenticated unfiltered Discover & Section Order
  // ============================================================
  await session.authenticate('login', {});
  requests.length = 0;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null,
        h(Route, { element: h(Layout) },
          h(Route, { path: '/', element: h(Discover) }),
          h(Route, { path: 'releases', element: h('div', { id: 'releases-view' }, 'Releases View') }),
          h(Route, { path: 'books/:id', element: h('div', { id: 'book-details-view' }, 'Book Details View') })
        )
      )
    )
  ));

  // Top Picks shown
  const topPicksSection = document.querySelector('.top-picks-section');
  assert.ok(topPicksSection, 'Top Picks rendered for logged-in user');

  const controlsSection = document.querySelector('.discovery-controls');
  const newReleasesHeading = document.getElementById('new-releases-heading');
  const upcomingHeading = document.getElementById('upcoming-releases-heading');
  const catalogHeading = document.getElementById('discover-heading');

  // Section order check: controls -> topPicks -> newReleases -> upcoming -> catalog
  assert.ok(controlsSection.compareDocumentPosition(topPicksSection) & 4, 'Controls before Top Picks');
  assert.ok(topPicksSection.compareDocumentPosition(newReleasesHeading) & 4, 'Top Picks before New Releases');
  assert.ok(newReleasesHeading.compareDocumentPosition(upcomingHeading) & 4, 'New Releases before Upcoming');
  assert.ok(upcomingHeading.compareDocumentPosition(catalogHeading) & 4, 'Upcoming before Catalog');

  // ============================================================
  // Tests 8, 9, 10, 11: Filters & Pagination hide all curated sections
  // ============================================================

  // Test 8: Search query hides all curated sections
  requests.length = 0;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/?q=autumn'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));
  assert.equal(document.querySelector('.top-picks-section'), null, 'Search query hides Top Picks');
  assert.equal(document.getElementById('new-releases-heading'), null, 'Search query hides New Releases');
  assert.equal(document.getElementById('upcoming-releases-heading'), null, 'Search query hides Upcoming');
  assert.ok(!requests.some(r => r.includes('/api/releases')), 'Search query does not fetch releases');

  // Test 9: Genre filter hides all curated sections
  requests.length = 0;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/?genre=fiction'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));
  assert.equal(document.querySelector('.top-picks-section'), null, 'Genre filter hides Top Picks');
  assert.equal(document.getElementById('new-releases-heading'), null, 'Genre filter hides New Releases');
  assert.equal(document.getElementById('upcoming-releases-heading'), null, 'Genre filter hides Upcoming');
  assert.ok(!requests.some(r => r.includes('/api/releases')), 'Genre filter does not fetch releases');

  // Test 10: Author filter hides all curated sections
  requests.length = 0;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/?author=Jane+Author'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));
  assert.equal(document.querySelector('.top-picks-section'), null, 'Author filter hides Top Picks');
  assert.equal(document.getElementById('new-releases-heading'), null, 'Author filter hides New Releases');
  assert.equal(document.getElementById('upcoming-releases-heading'), null, 'Author filter hides Upcoming');
  assert.ok(!requests.some(r => r.includes('/api/releases')), 'Author filter does not fetch releases');

  // Test 11: Page > 1 hides all curated sections
  requests.length = 0;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/?page=2'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));
  assert.equal(document.querySelector('.top-picks-section'), null, 'Page > 1 hides Top Picks');
  assert.equal(document.getElementById('new-releases-heading'), null, 'Page > 1 hides New Releases');
  assert.equal(document.getElementById('upcoming-releases-heading'), null, 'Page > 1 hides Upcoming');
  assert.ok(!requests.some(r => r.includes('/api/releases')), 'Page > 1 does not fetch releases');

  // ============================================================
  // Test 12: Release API error does not prevent normal Discover catalog rendering
  // ============================================================
  releasesApiError = true;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));

  assert.ok(document.querySelector('[role="alert"]'), 'Error alert rendered for releases failure');
  assert.ok(document.body.textContent.includes('Failed to load releases'));
  assert.ok(document.body.textContent.includes('Catalog Book 1'), 'Catalog book continues to render despite releases error');

  // Recover from error
  releasesApiError = false;

  // ============================================================
  // Tests 13 & 14: Empty states for New Releases and Upcoming
  // ============================================================
  releasesApiResponse = {
    asOf: '2026-09-15',
    windows: {
      newReleases: { from: '2026-06-17', to: '2026-09-15' },
      upcoming: { fromExclusive: '2026-09-15', to: '2027-03-14' },
    },
    newReleases: [],
    upcoming: [],
  };

  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));

  assert.ok(document.body.textContent.includes('No recent releases yet.'), 'New Releases empty state rendered');
  assert.ok(document.body.textContent.includes('No upcoming releases yet.'), 'Upcoming empty state rendered');
  assert.ok(document.body.textContent.includes('Catalog Book 1'), 'Catalog book still rendered with empty release sections');
});
