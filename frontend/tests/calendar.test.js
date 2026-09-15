import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Calendar frontend: protection, nav, 42-cell grid, month navigation, URL state, event rendering, overflow details, and resilience', { timeout: 60000 }, async t => {
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
  globalThis.window.scrollTo = () => {};
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

  let calendarApiResponse = {
    range: { from: '2026-08-31', to: '2026-10-11' },
    events: [
      {
        id: 'release:book-rel-1:2026-09-05',
        type: 'release',
        date: '2026-09-05',
        book: {
          id: 'book-rel-1',
          title: 'Autumn Leaves',
          author: 'Jane Author',
          coverImageUrl: null,
        },
      },
      {
        id: 'release:book-rel-2:2026-09-05',
        type: 'release',
        date: '2026-09-05',
        book: {
          id: 'book-rel-2',
          title: 'The Great Journey',
          author: 'John Writer',
          coverImageUrl: null,
        },
      },
      // Third release event on 2026-09-05 to cause overflow (>2)
      {
        id: 'release:book-rel-3:2026-09-05',
        type: 'release',
        date: '2026-09-05',
        book: {
          id: 'book-rel-3',
          title: 'Another Tale',
          author: 'Third Author',
          coverImageUrl: null,
        },
      },
      {
        id: 'release:book-rel-4:2026-09-24',
        type: 'release',
        date: '2026-09-24',
        book: {
          id: 'book-rel-4',
          title: 'Winter Horizon',
          author: 'Jane Author',
          coverImageUrl: null,
        },
      },
    ],
  };

  let calendarApiError = false;
  let isAuthenticated = false;

  globalThis.fetch = (input) => {
    const url = new URL(input);
    requests.push(url.toString());

    if (url.pathname === '/api/auth/refresh' || url.pathname === '/api/auth/me' || url.pathname === '/api/auth/login') {
      if (!isAuthenticated) {
        return Promise.resolve(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401));
      }
      return Promise.resolve(jsonResponse({
        user: { id: 'reader-1', username: 'reader' },
        accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`,
        expiresIn: 900,
      }));
    }
    if (url.pathname === '/api/genres') {
      return Promise.resolve(jsonResponse({ data: [] }));
    }
    if (url.pathname === '/api/notifications/unread-count') {
      return Promise.resolve(jsonResponse({ count: 0 }));
    }
    if (url.pathname === '/api/calendar') {
      if (!isAuthenticated) {
        return Promise.resolve(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401));
      }
      if (calendarApiError) {
        return Promise.resolve(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load calendar' } }, 500));
      }
      return Promise.resolve(jsonResponse(calendarApiResponse));
    }
    return Promise.resolve(jsonResponse({ data: [] }));
  };

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  const { default: Calendar, computeMonthGrid, parseMonthParam, getAdjacentMonth, getLocalCurrentMonthString } = await server.ssrLoadModule('/src/pages/Calendar.jsx');
  const { default: Layout } = await server.ssrLoadModule('/src/components/Layout.jsx');
  const { useAuth } = await server.ssrLoadModule('/src/hooks/useAuth.js');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
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

  // ============================================================
  // Test 1: Unauthenticated /calendar redirects to /login
  // ============================================================
  isAuthenticated = false;
  await session.initialize().catch(() => {});

  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step1', initialEntries: ['/calendar?month=2026-09'] },
        h(Routes, null,
          h(Route, { path: '/calendar', element: h(RequireAuth, null, h(Calendar)) }),
          h(Route, { path: '/login', element: h('div', null, 'Log in page') })
        )
      )
    );
  });

  assert.ok(document.body.textContent.includes('Log in page'), 'Unauthenticated /calendar redirects to login');

  // ============================================================
  // Test 2: Unauthenticated nav does not show Calendar
  // ============================================================
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

  const loggedOutNav = [...document.querySelectorAll('.main-nav a')].map(a => a.textContent.trim());
  assert.equal(loggedOutNav.includes('Calendar'), false, 'Calendar not in main-nav while logged out');

  // ============================================================
  // Authenticate user
  // ============================================================
  isAuthenticated = true;
  await act(async () => {
    await session.authenticate('login', {});
  });

  // ============================================================
  // Test 3: Authenticated main navigation contains Calendar after My Books
  // ============================================================
  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step3', initialEntries: ['/'] },
        h(Routes, null,
          h(Route, { element: h(Layout) },
            h(Route, { path: '/', element: h('div', null, 'Discover page') })
          )
        )
      )
    );
  });

  const authedNav = [...document.querySelectorAll('.main-nav a')].map(a => a.textContent.trim());
  assert.deepEqual(authedNav, ['Discover', 'Feed', 'My Books', 'Calendar', 'Challenges', 'Friends'], 'Nav has Calendar in correct position');

  // ============================================================
  // Test 4, 5, 6, 7, 8, 9: Month grid unit tests & 42 cells Mon-Sun
  // ============================================================
  const sep2026 = computeMonthGrid(2026, 9);
  assert.equal(sep2026.cells.length, 42, 'Grid contains exactly 42 cells');
  assert.equal(sep2026.from, '2026-08-31', 'September 2026 grid starts on Monday 2026-08-31');
  assert.equal(sep2026.to, '2026-10-11', 'September 2026 grid ends on Sunday 2026-10-11');
  assert.equal(sep2026.cells[0].isCurrentMonth, false, 'First cell is previous-month spillover');
  assert.equal(sep2026.cells[1].isCurrentMonth, true, 'Second cell (Sep 1) is current month');
  assert.equal(sep2026.cells[41].isCurrentMonth, false, 'Last cell is next-month spillover');

  // ============================================================
  // Test 10, 11: Year transitions Dec -> Jan and Jan -> Dec
  // ============================================================
  assert.equal(getAdjacentMonth(2026, 12, 1), '2027-01', 'Dec 2026 + 1 month = Jan 2027');
  assert.equal(getAdjacentMonth(2027, 1, -1), '2026-12', 'Jan 2027 - 1 month = Dec 2026');

  // ============================================================
  // Test 12, 13: Month param parsing and fallback
  // ============================================================
  const parsedValid = parseMonthParam('2026-09');
  assert.equal(parsedValid.year, 2026);
  assert.equal(parsedValid.month, 9);

  const parsedInvalid = parseMonthParam('invalid-month');
  assert.equal(parsedInvalid.str, getLocalCurrentMonthString(), 'Invalid month falls back to current month');

  // ============================================================
  // Test 14, 15, 16, 17, 18, 19, 20: Render Calendar page with data
  // ============================================================
  requests.length = 0;
  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step4', initialEntries: ['/calendar?month=2026-09'] },
        h(Routes, null,
          h(Route, { element: h(Layout) },
            h(Route, { path: 'calendar', element: h(Calendar) }),
            h(Route, { path: 'books/:id', element: h('div', { id: 'book-page' }, 'Book Page') })
          )
        )
      )
    );
  });

  // API called with exact visible range
  const calReq = requests.find(r => r.includes('/api/calendar'));
  assert.ok(calReq, 'Calendar API was requested');
  assert.ok(calReq.includes('from=2026-08-31'), 'Requested with from=2026-08-31');
  assert.ok(calReq.includes('to=2026-10-11'), 'Requested with to=2026-10-11');

  // Header & Title
  assert.ok(document.body.textContent.includes('September 2026'), 'Month title rendered in header');
  assert.equal(document.body.textContent.includes('Finished reading'), false, 'No finished reading text rendered');
  assert.equal(document.querySelector('.legend-finished'), null, 'No finished legend rendered');

  // Weekdays (Mon - Sun)
  const weekdays = [...document.querySelectorAll('.calendar-weekday-header')].map(el => el.textContent.trim());
  assert.deepEqual(weekdays, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], 'Weekday headers Monday to Sunday');

  // 42 cells rendered in DOM
  const cells = document.querySelectorAll('.calendar-cell');
  assert.equal(cells.length, 42, '42 calendar cell elements rendered in DOM');

  // Outside-month styling on first and last cells
  assert.ok(cells[0].classList.contains('outside-month'), 'First cell has outside-month styling');
  assert.ok(cells[41].classList.contains('outside-month'), 'Last cell has outside-month styling');
  assert.ok(!cells[1].classList.contains('outside-month'), 'Sep 1 cell is current month');

  // Release event badges
  assert.ok(document.body.textContent.includes('Autumn Leaves'), 'Release event rendered');
  assert.ok(document.body.textContent.includes('The Great Journey'), 'Second release event rendered');
  assert.ok(document.body.textContent.includes('Winter Horizon'), 'Winter Horizon release rendered');

  // Event links point to /books/:id
  const eventLink = document.querySelector('a.calendar-event-badge[href="/books/book-rel-1"]');
  assert.ok(eventLink, 'Event links to /books/book-rel-1');
  assert.equal(eventLink.getAttribute('aria-label'), 'Release: Autumn Leaves');

  // Overflow button for > 2 events
  const moreBtn = document.querySelector('.calendar-more-button');
  assert.ok(moreBtn, '+N more button rendered for day with 3 events');
  assert.equal(moreBtn.textContent.trim(), '+1 more');

  // Clicking +1 more opens day details panel with all 3 release events
  await act(async () => {
    moreBtn.click();
  });

  let dayDetails = document.querySelector('.calendar-day-details');
  assert.ok(dayDetails, 'Selected day details panel rendered');
  assert.ok(dayDetails.textContent.includes('September 5, 2026'), 'Details date header rendered');
  assert.ok(dayDetails.textContent.includes('Releases (3)'), 'Releases count heading in details');
  assert.equal(dayDetails.textContent.includes('Finished reading'), false, 'No finished reading section in details');
  assert.ok(dayDetails.textContent.includes('Another Tale'), '3rd release event visible in details');

  // ============================================================
  // Test 21, 22, 23: Previous, Next, Today controls & selected-day reset
  // ============================================================
  const prevBtn = document.querySelector('button[aria-label="Previous month"]');
  const nextBtn = document.querySelector('button[aria-label="Next month"]');
  const todayBtn = document.querySelector('button[aria-label="Current month"]');
  assert.ok(prevBtn, 'Previous button rendered');
  assert.ok(nextBtn, 'Next button rendered');
  assert.ok(todayBtn, 'Today button rendered');

  // Navigating to another month (Previous month) closes the details panel
  requests.length = 0;
  await act(async () => {
    prevBtn.click();
  });
  assert.ok(document.body.textContent.includes('August 2026'), 'Previous button navigates to August 2026');
  assert.equal(document.querySelector('.calendar-day-details'), null, 'Selected day details closed on month navigation');

  // Click Next month back to September 2026
  await act(async () => {
    nextBtn.click();
  });
  assert.ok(document.body.textContent.includes('September 2026'), 'Next button navigates back to September 2026');
  assert.equal(document.querySelector('.calendar-day-details'), null, 'Details panel remains closed until day is selected');

  // Re-select a day (clicking on Sep 5 cell)
  const sep5Cell = [...document.querySelectorAll('.calendar-cell')].find(c => c.textContent.includes('Autumn Leaves'));
  assert.ok(sep5Cell, 'Found September 5 cell');
  await act(async () => {
    sep5Cell.click();
  });
  assert.ok(document.querySelector('.calendar-day-details'), 'Details opened again after clicking day cell');

  // Direct URL / query month change to another month also resets selected day
  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step4-oct', initialEntries: ['/calendar?month=2026-10'] },
        h(Routes, null,
          h(Route, { element: h(Layout) },
            h(Route, { path: 'calendar', element: h(Calendar) })
          )
        )
      )
    );
  });
  assert.ok(document.body.textContent.includes('October 2026'), 'Direct URL change navigated to October 2026');
  assert.equal(document.querySelector('.calendar-day-details'), null, 'Direct URL/query month change cleared selected day');

  // ============================================================
  // Test 24: Empty month still renders 42-cell calendar and empty details
  // ============================================================
  calendarApiResponse = {
    range: { from: '2026-08-31', to: '2026-10-11' },
    events: [],
  };

  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step5', initialEntries: ['/calendar?month=2026-09'] },
        h(Routes, null,
          h(Route, { element: h(Layout) },
            h(Route, { path: 'calendar', element: h(Calendar) })
          )
        )
      )
    );
  });

  assert.equal(document.querySelectorAll('.calendar-cell').length, 42, 'Empty month still renders 42 cells');
  assert.equal(document.querySelectorAll('.calendar-event-badge').length, 0, 'No event badges in empty month');

  // Click cell in empty month
  const emptyCell = document.querySelectorAll('.calendar-cell')[1];
  await act(async () => {
    emptyCell.click();
  });
  assert.ok(document.body.textContent.includes('No book releases on this date.'), 'Empty day details message rendered');

  // ============================================================
  // Test 25: API error shows ErrorNotice and retry button without breaking shell
  // ============================================================
  calendarApiError = true;

  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step6', initialEntries: ['/calendar?month=2026-09'] },
        h(Routes, null,
          h(Route, { element: h(Layout) },
            h(Route, { path: 'calendar', element: h(Calendar) })
          )
        )
      )
    );
  });

  assert.ok(document.querySelector('[role="alert"]'), 'Error alert rendered on API error');
  assert.ok(document.body.textContent.includes('Failed to load calendar'));
  const retryBtn = [...document.querySelectorAll('button')].find(b => b.textContent === 'Try again');
  assert.ok(retryBtn, 'Retry button rendered');

  calendarApiError = false;
  await act(async () => {
    retryBtn.click();
  });
  assert.equal(document.querySelector('[role="alert"]'), null, 'Error notice dismissed on successful retry');
});


