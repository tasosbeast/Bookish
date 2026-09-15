import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Challenges frontend: protection, navigation, progress states, completed state, trophies in Account, and error resilience', { timeout: 60000 }, async t => {
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

  let currentChallengeData = {
    data: {
      key: '2026-09',
      title: 'September 2026 Reading Challenge',
      description: 'Finish 3 different books this month.',
      goal: 3,
      progress: 2,
      completed: false,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-10-01T00:00:00.000Z',
      completedAt: null,
      books: [
        { id: 'b2', title: 'Neuromancer', author: 'William Gibson', coverImageUrl: null, finishedAt: '2026-09-10T14:00:00.000Z' },
        { id: 'b1', title: 'Dune', author: 'Frank Herbert', coverImageUrl: null, finishedAt: '2026-09-02T10:00:00.000Z' },
      ],
    },
  };

  let trophiesData = {
    data: [
      {
        key: '2026-09',
        title: 'September 2026 Reading Challenge',
        goal: 3,
        completedAt: '2026-09-18T15:30:00.000Z',
        booksRead: 5,
      },
      {
        key: '2026-08',
        title: 'August 2026 Reading Challenge',
        goal: 3,
        completedAt: '2026-08-20T12:00:00.000Z',
        booksRead: 3,
      },
    ],
  };

  let challengeApiError = false;
  let trophiesApiError = false;

  globalThis.fetch = (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || 'GET';
    requests.push(`${method} ${url.toString()}`);

    if (url.pathname === '/api/auth/login') {
      const payload = btoa(JSON.stringify({ sub: 'reader-1', exp: 2000000000 }));
      return Promise.resolve(jsonResponse({
        user: { id: 'reader-1', username: 'reader', bio: 'I love books', email: 'reader@example.com' },
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
    if (url.pathname === '/api/challenges/current') {
      if (challengeApiError) {
        return Promise.resolve(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Challenge load error' } }, 500));
      }
      return Promise.resolve(jsonResponse(currentChallengeData));
    }
    if (url.pathname === '/api/challenges/trophies') {
      if (trophiesApiError) {
        return Promise.resolve(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Trophies load error' } }, 500));
      }
      return Promise.resolve(jsonResponse(trophiesData));
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
  const { default: Challenges } = await server.ssrLoadModule('/src/pages/Challenges.jsx');
  const { default: Account } = await server.ssrLoadModule('/src/pages/Account.jsx');
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

  // 1. Unauthenticated navigation to /challenges redirects to /login
  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step1', initialEntries: ['/challenges'] },
        h(Routes, null,
          h(Route, { path: '/challenges', element: h(RequireAuth, null, h(Challenges)) }),
          h(Route, { path: '/login', element: h('div', null, 'Log in page') })
        )
      )
    );
  });
  assert.ok(document.body.textContent.includes('Log in page'), 'Unauthenticated /challenges redirects to login');

  // Authenticate user
  await act(async () => {
    await session.authenticate('login', {});
  });

  // 2. Authenticated main navigation contains Challenges
  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step2', initialEntries: ['/'] },
        h(Routes, null,
          h(Route, { element: h(Layout) },
            h(Route, { path: '/', element: h('div', null, 'Discover page') })
          )
        )
      )
    );
  });
  const navLinks = Array.from(document.querySelectorAll('.main-nav a')).map(a => a.textContent);
  assert.ok(navLinks.includes('Challenges'), 'Challenges appears in main navigation');
  assert.deepEqual(navLinks, ['Discover', 'Releases', 'Feed', 'My Books', 'Challenges', 'Friends'], 'Main navigation has items in correct order');

  // 3. Partial progress rendering (2 of 3 books)
  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step3', initialEntries: ['/challenges'] },
        h(Routes, null,
          h(Route, { path: '/challenges', element: h(Challenges) })
        )
      )
    );
  });

  assert.ok(document.body.textContent.includes('Finish books and track your monthly reading progress.'), 'Displays updated intro copy');
  assert.ok(document.body.textContent.includes('September 2026 Reading Challenge'), 'Displays challenge title');
  assert.ok(document.body.textContent.includes('2 of 3 books'), 'Displays progress count');
  const progressBar = document.querySelector('[role="progressbar"]');
  assert.ok(progressBar, 'Progress bar exists with role="progressbar"');
  assert.equal(progressBar.getAttribute('aria-valuenow'), '2');
  assert.equal(progressBar.getAttribute('aria-valuemin'), '0');
  assert.equal(progressBar.getAttribute('aria-valuemax'), '3');
  assert.equal(progressBar.getAttribute('aria-valuetext'), '2 of 3 books');

  // Books displayed and link to /books/:id
  const bookLinks = Array.from(document.querySelectorAll('.challenge-book-name a'));
  assert.equal(bookLinks.length, 2);
  assert.equal(bookLinks[0].textContent, 'Neuromancer');
  assert.equal(bookLinks[0].getAttribute('href'), '/books/b2');
  assert.equal(bookLinks[1].textContent, 'Dune');
  assert.equal(bookLinks[1].getAttribute('href'), '/books/b1');

  // 4. Empty state (0 of 3 books)
  currentChallengeData = {
    data: {
      key: '2026-09',
      title: 'September 2026 Reading Challenge',
      description: 'Finish 3 different books this month.',
      goal: 3,
      progress: 0,
      completed: false,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-10-01T00:00:00.000Z',
      completedAt: null,
      books: [],
    },
  };

  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step4', initialEntries: ['/challenges'] },
        h(Routes, null,
          h(Route, { path: '/challenges', element: h(Challenges) })
        )
      )
    );
  });

  assert.ok(document.body.textContent.includes('0 of 3 books'), 'Displays 0 of 3');
  assert.ok(document.body.textContent.includes('Your next finished book starts the challenge.'), 'Displays zero-progress helper message');
  const findBookBtn = document.querySelector('a.button[href="/"]');
  assert.ok(findBookBtn, 'Find a book CTA button exists linking to Discover');

  // 5. Completed state (5 of 3 books) — progress bar visually capped at 100%
  currentChallengeData = {
    data: {
      key: '2026-09',
      title: 'September 2026 Reading Challenge',
      description: 'Finish 3 different books this month.',
      goal: 3,
      progress: 5,
      completed: true,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-10-01T00:00:00.000Z',
      completedAt: '2026-09-18T15:30:00.000Z',
      books: [
        { id: 'b5', title: 'Book 5', author: 'Author 5', coverImageUrl: null, finishedAt: '2026-09-22T00:00:00.000Z' },
        { id: 'b4', title: 'Book 4', author: 'Author 4', coverImageUrl: null, finishedAt: '2026-09-20T00:00:00.000Z' },
        { id: 'b3', title: 'Book 3', author: 'Author 3', coverImageUrl: null, finishedAt: '2026-09-18T15:30:00.000Z' },
        { id: 'b2', title: 'Book 2', author: 'Author 2', coverImageUrl: null, finishedAt: '2026-09-10T00:00:00.000Z' },
        { id: 'b1', title: 'Book 1', author: 'Author 1', coverImageUrl: null, finishedAt: '2026-09-02T00:00:00.000Z' },
      ],
    },
  };

  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step5', initialEntries: ['/challenges'] },
        h(Routes, null,
          h(Route, { path: '/challenges', element: h(Challenges) })
        )
      )
    );
  });

  assert.ok(document.body.textContent.includes('5 of 3 books'), 'Shows progress beyond goal');
  assert.ok(document.body.textContent.includes('Monthly challenge complete'), 'Shows completion badge / message');
  assert.ok(document.body.textContent.includes('5 books finished — trophy earned.'), 'Shows trophy earned message');
  const barFill = document.querySelector('.challenge-progress-bar-fill');
  assert.equal(barFill.style.width, '100%', 'Progress bar fill capped visually at 100%');
  const completedProgressBar = document.querySelector('[role="progressbar"]');
  assert.equal(completedProgressBar.getAttribute('aria-valuenow'), '3', 'aria-valuenow is capped at goal');
  assert.equal(completedProgressBar.getAttribute('aria-valuemin'), '0', 'aria-valuemin is 0');
  assert.equal(completedProgressBar.getAttribute('aria-valuemax'), '3', 'aria-valuemax remains goal');
  assert.equal(completedProgressBar.getAttribute('aria-valuetext'), '5 of 3 books — challenge complete', 'aria-valuetext communicates real progress');

  // 6. Error and retry on Challenges page
  challengeApiError = true;
  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step6', initialEntries: ['/challenges'] },
        h(Routes, null,
          h(Route, { path: '/challenges', element: h(Challenges) })
        )
      )
    );
  });
  assert.ok(document.body.textContent.includes('Challenge load error'), 'Displays error notice on failure');
  const retryBtn = document.querySelector('.error-notice .text-button');
  assert.ok(retryBtn, 'Retry button exists');

  // Click retry after restoring
  challengeApiError = false;
  await act(async () => {
    retryBtn.click();
  });
  assert.ok(document.body.textContent.includes('September 2026 Reading Challenge'), 'Restores challenge after retry');

  // ====================================================
  // 7. Account page: My Bookish Trophies section
  // ====================================================
  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step7', initialEntries: ['/account'] },
        h(Routes, null,
          h(Route, { path: '/account', element: h(Account) })
        )
      )
    );
  });

  assert.ok(document.body.textContent.includes('My Bookish Trophies'), 'Account page has My Bookish Trophies heading');
  const trophyCards = Array.from(document.querySelectorAll('.trophy-card'));
  assert.equal(trophyCards.length, 2, 'Renders 2 trophy cards');

  // Check ordering: September before August
  assert.ok(trophyCards[0].textContent.includes('September 2026 Reading Challenge'));
  assert.ok(trophyCards[0].textContent.includes('Completed Sep 18, 2026'));
  assert.ok(trophyCards[0].textContent.includes('5 books finished'));

  assert.ok(trophyCards[1].textContent.includes('August 2026 Reading Challenge'));
  assert.ok(trophyCards[1].textContent.includes('Completed Aug 20, 2026'));
  assert.ok(trophyCards[1].textContent.includes('3 books finished'));

  // 8. Account page: Empty trophies state
  trophiesData = { data: [] };
  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step8', initialEntries: ['/account'] },
        h(Routes, null,
          h(Route, { path: '/account', element: h(Account) })
        )
      )
    );
  });

  assert.ok(document.body.textContent.includes('No trophies yet. Finish 3 different books in a month to earn your first one.'));
  const viewChallengesLink = document.querySelector('a[href="/challenges"]');
  assert.ok(viewChallengesLink, 'Link to /challenges exists in empty trophies state');

  // 9. Account resilience: Trophy error does NOT break profile editing
  trophiesApiError = true;
  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step9', initialEntries: ['/account'] },
        h(Routes, null,
          h(Route, { path: '/account', element: h(Account) })
        )
      )
    );
  });

  // Trophy section shows localized error
  assert.ok(document.body.textContent.includes('Trophies load error'), 'Trophy error displayed');
  // Profile editing is still fully functional
  assert.ok(document.body.textContent.includes('Reader profile'), 'Profile heading still renders');
  assert.ok(document.body.textContent.includes('Edit profile'), 'Edit profile button still present and usable');
  assert.ok(document.body.textContent.includes('Browser notifications'), 'Browser notifications section still present');
});
