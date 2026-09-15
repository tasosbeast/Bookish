import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Discover releases integration: limit 24, default 8, independent inline expansion, filters, error, empty states, and route removal', { timeout: 60000 }, async t => {
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

  // Create 12 new releases and 10 upcoming releases (>8 each)
  const generateBooks = (prefix, count, date, type) => Array.from({ length: count }, (_, i) => ({
    id: `book-${prefix}-${i + 1}`,
    title: `${type} Book ${i + 1}`,
    author: `Author ${prefix} ${i + 1}`,
    isbn: `97800000000${String(i).padStart(2, '0')}`,
    coverImageUrl: null,
    publicationYear: 2026,
    publicationDate: date,
    averageRating: 4.5,
    genres: [{ id: `g-${prefix}`, name: 'Fiction', slug: 'fiction' }],
  }));

  let releasesApiResponse = {
    asOf: '2026-09-15',
    windows: {
      newReleases: { from: '2026-06-17', to: '2026-09-15' },
      upcoming: { fromExclusive: '2026-09-15', to: '2027-03-14' },
    },
    newReleases: generateBooks('new', 12, '2026-09-05', 'New'),
    upcoming: generateBooks('up', 10, '2026-09-24', 'Upcoming'),
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
      return Promise.resolve(jsonResponse({ data: [], meta: { personalized: false } }));
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

  const { default: App } = await server.ssrLoadModule('/src/App.jsx');
  const { default: Discover } = await server.ssrLoadModule('/src/pages/Discover.jsx');
  const { default: Layout } = await server.ssrLoadModule('/src/components/Layout.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, Routes, Route } = await import('react-router-dom');

  root = createRoot(document.getElementById('root'));
  await session.initialize();

  // ============================================================
  // Test 1: Discover calls /api/releases?limit=24 exactly once in curated state
  // ============================================================
  requests.length = 0;
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null,
        h(Route, { element: h(Layout) },
          h(Route, { path: '/', element: h(Discover) }),
          h(Route, { path: 'books/:id', element: h('div', { id: 'book-details-view' }, 'Book Details View') })
        )
      )
    )
  ));

  const releaseRequests = requests.filter(r => r.includes('/api/releases'));
  assert.equal(releaseRequests.length, 1, 'Release API called exactly once on unfiltered Discover');
  assert.ok(releaseRequests[0].includes('limit=24'), 'Release API called with limit=24');

  // ============================================================
  // Test 2 & 3: Initially shows max 8 books per section
  // ============================================================
  const newGrid = document.getElementById('new-releases-grid');
  const upGrid = document.getElementById('upcoming-releases-grid');
  assert.ok(newGrid, 'New releases grid rendered');
  assert.ok(upGrid, 'Upcoming releases grid rendered');

  assert.equal(newGrid.querySelectorAll('.book-card').length, 8, 'New Releases initially shows max 8 books');
  assert.equal(upGrid.querySelectorAll('.book-card').length, 8, 'Upcoming initially shows max 8 books');

  // Test 9: Exact date labels
  assert.ok(document.body.textContent.includes('Released Sep 5, 2026'), 'Exact released date label rendered');
  assert.ok(document.body.textContent.includes('Coming Sep 24, 2026'), 'Exact upcoming date label rendered');

  // Test 17: Releases main-nav link remains absent
  const mainNavReleases = [...document.querySelectorAll('.main-nav a')].find(a => a.textContent === 'Releases');
  assert.equal(mainNavReleases, undefined, 'Releases main-nav link remains absent');

  // ============================================================
  // Test 4, 5, 6, 7: Show more / Show less buttons & independent expansion below grids
  // ============================================================
  const newSection = document.querySelector('section[aria-labelledby="new-releases-heading"]');
  const upcomingSection = document.querySelector('section[aria-labelledby="upcoming-releases-heading"]');

  // Verify section headings do not contain expansion buttons
  assert.equal(newSection.querySelector('.section-heading button'), null, 'New Releases heading has no expansion button');
  assert.equal(upcomingSection.querySelector('.section-heading button'), null, 'Upcoming heading has no expansion button');

  const showMoreNew = newSection.querySelector('.section-actions button.text-button');
  const showMoreUpcoming = upcomingSection.querySelector('.section-actions button.text-button');

  assert.ok(showMoreNew, 'New Releases Show more button rendered when >8 books');
  assert.equal(showMoreNew.textContent.trim(), 'Show more');
  assert.equal(showMoreNew.getAttribute('aria-expanded'), 'false');
  assert.equal(showMoreNew.getAttribute('aria-controls'), 'new-releases-grid');
  assert.ok(newGrid.nextElementSibling.contains(showMoreNew), 'Show more container appears immediately after New Releases grid');
  assert.ok(newGrid.compareDocumentPosition(showMoreNew) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'Show more appears after New Releases grid');

  assert.ok(showMoreUpcoming, 'Upcoming Show more button rendered when >8 books');
  assert.equal(showMoreUpcoming.textContent.trim(), 'Show more');
  assert.equal(showMoreUpcoming.getAttribute('aria-expanded'), 'false');
  assert.equal(showMoreUpcoming.getAttribute('aria-controls'), 'upcoming-releases-grid');
  assert.ok(upGrid.nextElementSibling.contains(showMoreUpcoming), 'Show more container appears immediately after Upcoming grid');
  assert.ok(upGrid.compareDocumentPosition(showMoreUpcoming) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'Show more appears after Upcoming grid');

  // Test 6: Expanding New Releases does NOT expand Upcoming
  await act(async () => {
    showMoreNew.click();
  });

  assert.equal(newSection.querySelectorAll('.book-card').length, 12, 'New Releases expands to all 12 returned books');
  assert.equal(showMoreNew.textContent.trim(), 'Show less', 'Button text toggles to Show less');
  assert.equal(showMoreNew.getAttribute('aria-expanded'), 'true');
  assert.ok(newGrid.compareDocumentPosition(showMoreNew) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'Show less remains below the expanded New Releases grid');
  assert.equal(upcomingSection.querySelectorAll('.book-card').length, 8, 'Upcoming remains collapsed at 8 books');

  // Test 7: Expanding Upcoming does NOT collapse New Releases (independent expansion)
  await act(async () => {
    showMoreUpcoming.click();
  });

  assert.equal(upcomingSection.querySelectorAll('.book-card').length, 10, 'Upcoming expands to all 10 returned books');
  assert.equal(showMoreUpcoming.textContent.trim(), 'Show less');
  assert.equal(showMoreUpcoming.getAttribute('aria-expanded'), 'true');
  assert.ok(upGrid.compareDocumentPosition(showMoreUpcoming) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'Show less remains below the expanded Upcoming grid');
  assert.equal(newSection.querySelectorAll('.book-card').length, 12, 'New Releases remains expanded');

  // Test 4: Show less collapses back to 8
  await act(async () => {
    showMoreNew.click();
  });

  assert.equal(newSection.querySelectorAll('.book-card').length, 8, 'New Releases collapses back to 8 books');
  assert.equal(showMoreNew.textContent.trim(), 'Show more');
  assert.equal(showMoreNew.getAttribute('aria-expanded'), 'false');
  assert.ok(newGrid.compareDocumentPosition(showMoreNew) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'Show more appears immediately after 8-card grid');
  assert.equal(upcomingSection.querySelectorAll('.book-card').length, 10, 'Upcoming remains expanded');

  // ============================================================
  // Test 8: If a section contains <=8 books, no Show more button is rendered
  // ============================================================
  releasesApiResponse = {
    asOf: '2026-09-15',
    windows: {
      newReleases: { from: '2026-06-17', to: '2026-09-15' },
      upcoming: { fromExclusive: '2026-09-15', to: '2027-03-14' },
    },
    newReleases: generateBooks('new', 5, '2026-09-05', 'New'),
    upcoming: generateBooks('up', 8, '2026-09-24', 'Upcoming'),
  };

  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null,
        h(Route, { element: h(Layout) },
          h(Route, { path: '/', element: h(Discover) })
        )
      )
    )
  ));

  const newSec5 = document.querySelector('section[aria-labelledby="new-releases-heading"]');
  const upSec8 = document.querySelector('section[aria-labelledby="upcoming-releases-heading"]');
  assert.equal(newSec5.querySelector('button.text-button'), null, 'No Show more button for 5 books');
  assert.equal(upSec8.querySelector('button.text-button'), null, 'No Show more button for 8 books');

  // ============================================================
  // Tests 10, 11, 12, 13: Filters & Pagination hide all curated sections
  // ============================================================
  // Test 10: Search hides curated sections
  requests.length = 0;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/?q=autumn'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));
  assert.equal(document.getElementById('new-releases-heading'), null, 'Search query hides New Releases');
  assert.equal(document.getElementById('upcoming-releases-heading'), null, 'Search query hides Upcoming');
  assert.ok(!requests.some(r => r.includes('/api/releases')), 'Search query does not fetch releases');

  // Test 11: Genre filter hides curated sections
  requests.length = 0;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/?genre=fiction'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));
  assert.equal(document.getElementById('new-releases-heading'), null, 'Genre filter hides New Releases');
  assert.equal(document.getElementById('upcoming-releases-heading'), null, 'Genre filter hides Upcoming');
  assert.ok(!requests.some(r => r.includes('/api/releases')), 'Genre filter does not fetch releases');

  // Test 12: Author filter hides curated sections
  requests.length = 0;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/?author=Author+new+1'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));
  assert.equal(document.getElementById('new-releases-heading'), null, 'Author filter hides New Releases');
  assert.equal(document.getElementById('upcoming-releases-heading'), null, 'Author filter hides Upcoming');
  assert.ok(!requests.some(r => r.includes('/api/releases')), 'Author filter does not fetch releases');

  // Test 13: Page > 1 hides curated sections
  requests.length = 0;
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/?page=2'] },
      h(Routes, null, h(Route, { path: '/', element: h(Discover) }))
    )
  ));
  assert.equal(document.getElementById('new-releases-heading'), null, 'Page > 1 hides New Releases');
  assert.equal(document.getElementById('upcoming-releases-heading'), null, 'Page > 1 hides Upcoming');
  assert.ok(!requests.some(r => r.includes('/api/releases')), 'Page > 1 does not fetch releases');

  // ============================================================
  // Test 14: Release API error does not break normal Discover catalog
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
  releasesApiError = false;

  // ============================================================
  // Test 15: Empty states remain correct
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

  // ============================================================
  // Test 16: /releases route no longer exists (renders fallback 404)
  // ============================================================
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  window.history.pushState({}, '', '/releases');
  await act(async () => root.render(h(App)));

  assert.ok(document.body.textContent.includes('This page has turned'), '/releases route hits 404 fallback');
  assert.ok(document.body.textContent.includes('Use Discover to find your way back to the books.'));
});
