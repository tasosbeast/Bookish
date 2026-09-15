import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Feed frontend: protection, navigation, activity types, empty states, pagination, error and retry', { timeout: 60000 }, async t => {
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

  let feedPage1 = {
    data: [
      {
        id: 'act-1',
        type: 'started_reading',
        createdAt: new Date().toISOString(),
        actor: { id: 'friend-1', username: 'Maria', profilePicture: null },
        book: { id: 'book-1', title: 'Dune', author: 'Frank Herbert', coverImageUrl: null, isbn: '9780441013593' },
        rating: null,
        review: null,
      },
      {
        id: 'act-2',
        type: 'finished_reading',
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        actor: { id: 'friend-1', username: 'Maria', profilePicture: null },
        book: { id: 'book-2', title: 'Neuromancer', author: 'William Gibson', coverImageUrl: null, isbn: '9780441569595' },
        rating: null,
        review: null,
      },
      {
        id: 'act-3',
        type: 'rated_book',
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        actor: { id: 'friend-2', username: 'Alex', profilePicture: null },
        book: { id: 'book-3', title: 'Foundation', author: 'Isaac Asimov', coverImageUrl: null, isbn: '9780553293357' },
        rating: 4,
        review: null,
      },
      {
        id: 'act-4',
        type: 'reviewed_book',
        createdAt: new Date(Date.now() - 10800000).toISOString(),
        actor: { id: 'friend-2', username: 'Alex', profilePicture: null },
        book: { id: 'book-4', title: 'Snow Crash', author: 'Neal Stephenson', coverImageUrl: null, isbn: '9780553380957' },
        rating: 5,
        review: { id: 'rev-1', reviewText: 'Visionary cyberpunk masterpiece.' },
      },
    ],
    meta: {
      nextCursor: 'page-2-cursor',
    },
  };

  let feedPage2 = {
    data: [
      {
        id: 'act-5',
        type: 'started_reading',
        createdAt: new Date(Date.now() - 14400000).toISOString(),
        actor: { id: 'friend-1', username: 'Maria', profilePicture: null },
        book: { id: 'book-5', title: 'Hyperion', author: 'Dan Simmons', coverImageUrl: null, isbn: '9780553283686' },
        rating: null,
        review: null,
      },
    ],
    meta: {
      nextCursor: null,
    },
  };

  let feedError = false;
  let emptyFeed = false;

  globalThis.fetch = (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || 'GET';
    requests.push(`${method} ${url.toString()}`);

    if (url.pathname === '/api/auth/login') {
      const payload = btoa(JSON.stringify({ sub: 'reader-1', exp: 2000000000 }));
      return Promise.resolve(jsonResponse({
        user: { id: 'reader-1', username: 'reader' },
        accessToken: `header.${payload}.signature`,
        expiresIn: 900,
      }));
    }
    if (url.pathname === '/api/auth/refresh' || url.pathname === '/api/auth/me') {
      return Promise.resolve(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401));
    }
    if (url.pathname.startsWith('/api/notifications')) {
      return Promise.resolve(jsonResponse({ data: [], unreadCount: 0 }));
    }
    if (url.pathname === '/api/genres') {
      return Promise.resolve(jsonResponse({ data: [] }));
    }
    if (url.pathname === '/api/feed') {
      if (feedError) {
        return Promise.resolve(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load feed' } }, 500));
      }
      if (emptyFeed) {
        return Promise.resolve(jsonResponse({ data: [], meta: { nextCursor: null } }));
      }
      const cursor = url.searchParams.get('cursor');
      if (cursor === 'page-2-cursor') {
        return Promise.resolve(jsonResponse(feedPage2));
      }
      return Promise.resolve(jsonResponse(feedPage1));
    }
    return Promise.resolve(jsonResponse({ data: [] }));
  };

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { useAuth } = await server.ssrLoadModule('/src/hooks/useAuth.js');
  const { default: Layout } = await server.ssrLoadModule('/src/components/Layout.jsx');
  const { default: Feed } = await server.ssrLoadModule('/src/pages/Feed.jsx');
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, Routes, Route, Navigate, useLocation } = await import('react-router-dom');

  function RequireAuth({ children }) {
    const auth = useAuth();
    const location = useLocation();
    if (auth.status === 'restoring') return h('div', null, 'Loading...');
    if (!auth.user) return h(Navigate, { to: `/login?next=${encodeURIComponent(location.pathname + location.search)}`, replace: true });
    return children;
  }

  root = createRoot(document.getElementById('root'));

  await session.initialize().catch(() => {});

  // 1. Unauthenticated navigation to /feed redirects to login
  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step1', initialEntries: ['/feed'] },
        h(Routes, null,
          h(Route, { path: '/feed', element: h(RequireAuth, null, h(Feed)) }),
          h(Route, { path: '/login', element: h('div', null, 'Log in page') })
        )
      )
    );
  });
  assert.ok(document.body.textContent.includes('Log in page'), 'Unauthenticated /feed redirects to login');

  // Authenticate user
  await act(async () => {
    await session.authenticate('login', {});
  });

  // 2. Authenticated user sees Feed in main nav
  await act(async () => root.render(
    h(MemoryRouter, { key: 'step2', initialEntries: ['/'] },
      h(Routes, null,
        h(Route, { element: h(Layout) },
          h(Route, { path: '/', element: h('div', null, 'Discover page') }),
          h(Route, { path: '/feed', element: h(Feed) })
        )
      )
    )
  ));

  const feedNavLink = document.querySelector('a[href="/feed"]');
  assert.ok(feedNavLink, 'Main navigation includes Feed link when authenticated');
  assert.equal(feedNavLink.textContent.trim(), 'Feed');

  // Check nav link order: Discover | Feed | My Books | Challenges | Friends
  const navLinks = [...document.querySelectorAll('.main-nav a')].map(a => a.textContent.trim());
  assert.deepEqual(navLinks, ['Discover', 'Feed', 'My Books', 'Challenges', 'Friends'], 'Navigation order matches spec');

  // 3. Render /feed page with initial activity items
  await act(async () => root.render(
    h(MemoryRouter, { key: 'step3', initialEntries: ['/feed'] },
      h(Routes, null,
        h(Route, { path: '/feed', element: h(Feed) })
      )
    )
  ));

  assert.ok(document.body.textContent.includes('Friends Activity'), 'Renders Friends Activity heading');

  // Check all four activity types
  assert.ok(document.body.textContent.includes('Maria started reading Dune'), 'started_reading text rendered');
  assert.ok(document.body.textContent.includes('Maria finished reading Neuromancer'), 'finished_reading text rendered');
  assert.ok(document.body.textContent.includes('Alex rated Foundation'), 'rated_book text rendered');
  assert.ok(document.body.textContent.includes('Alex reviewed Snow Crash'), 'reviewed_book text rendered');

  // Check review stars and snippet
  assert.ok(document.body.textContent.includes('Visionary cyberpunk masterpiece.'), 'Review text snippet rendered');
  const reviewStars = document.querySelector('.feed-review-rating .feed-rating-stars');
  assert.ok(reviewStars, 'Review stars rendered');
  assert.equal(reviewStars.textContent, '★★★★★');

  // Check rated_book stars
  const ratedStars = document.querySelector('#activity-act-3 .feed-rating-stars');
  assert.ok(ratedStars, 'Rating stars rendered');
  assert.equal(ratedStars.textContent, '★★★★☆');

  // Check book link
  const bookLink = document.querySelector('a[href="/books/book-1"]');
  assert.ok(bookLink, 'Book link points to /books/:id');

  // 4. "Load more" button appends page 2
  const loadMoreBtn = document.querySelector('.load-more-button');
  assert.ok(loadMoreBtn, 'Load more button present when nextCursor is set');

  await act(async () => {
    loadMoreBtn.click();
  });

  assert.ok(document.body.textContent.includes('Maria started reading Hyperion'), 'Appended page 2 items');
  // Original items still present
  assert.ok(document.body.textContent.includes('Maria started reading Dune'), 'Preserved page 1 items');

  // Page 2 had nextCursor: null, so Load more button should disappear
  const loadMoreAfter = document.querySelector('.load-more-button');
  assert.equal(loadMoreAfter, null, 'No load more button when nextCursor is null');

  // 5. Empty state rendering
  emptyFeed = true;
  await act(async () => root.render(
    h(MemoryRouter, { key: 'step4', initialEntries: ['/feed'] },
      h(Routes, null,
        h(Route, { path: '/feed', element: h(Feed) })
      )
    )
  ));

  assert.ok(document.body.textContent.includes('No activity yet.'), 'Empty state title rendered');
  assert.ok(document.body.textContent.includes("When your friends start, finish, rate, or review books, you'll see it here."), 'Empty state description rendered');
  const findReadersBtn = document.querySelector('a[href="/friends"]');
  assert.ok(findReadersBtn, 'CTA links to /friends');
  assert.equal(findReadersBtn.textContent.trim(), 'Find readers');

  // 6. Error and retry state
  emptyFeed = false;
  feedError = true;
  await act(async () => root.render(
    h(MemoryRouter, { key: 'step5', initialEntries: ['/feed'] },
      h(Routes, null,
        h(Route, { path: '/feed', element: h(Feed) })
      )
    )
  ));

  assert.ok(document.querySelector('.error-notice'), 'Error notice rendered on failure');
  const retryBtn = document.querySelector('.error-notice button');
  assert.ok(retryBtn, 'Retry button rendered');

  // Clearing error and clicking retry
  feedError = false;
  await act(async () => {
    retryBtn.click();
  });

  assert.ok(document.body.textContent.includes('Maria started reading Dune'), 'Feed reloaded after retry');
});
