import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Friends frontend: protection, tabs, reader suggestions, request flows, empty states, and errors', { timeout: 60000 }, async t => {
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
  const friendPostCalls = [];
  const friendDeleteCalls = [];

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

  let suggestionsData = {
    data: [
      {
        user: { id: 'cand-1', username: 'Reader_Maria', profilePicture: null, bio: 'A vivid reader' },
        reason: { type: 'genres', genres: ['Thriller', 'Mystery'], commonRatedBooks: 0, sharedBooks: 2 },
      },
    ],
    meta: { personalized: true, eligibleBooks: 8, minimumBooks: 5 },
  };

  let friendsData = {
    data: [
      {
        friendshipId: 'f-1',
        friend: { id: 'friend-1', username: 'Friend_Alex', profilePicture: null, bio: 'Coffee & novels' },
        acceptedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  };

  let requestsData = {
    data: {
      incoming: [
        { id: 'req-in-1', user: { id: 'user-in-1', username: 'Incoming_Sam', profilePicture: null, bio: null }, createdAt: '2026-09-10T00:00:00.000Z' },
      ],
      sent: [
        { id: 'req-sent-1', user: { id: 'user-sent-1', username: 'Sent_Taylor', profilePicture: null, bio: null }, createdAt: '2026-09-10T00:00:00.000Z' },
      ],
    },
  };

  let postError = false;

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
    if (url.pathname === '/api/books') {
      return Promise.resolve(jsonResponse({ data: [], pagination: { page: 1, limit: 18, total: 0, totalPages: 1 } }));
    }
    if (url.pathname === '/api/friends/suggestions') {
      return Promise.resolve(jsonResponse(suggestionsData));
    }
    if (url.pathname === '/api/friends/requests' && method === 'GET') {
      return Promise.resolve(jsonResponse(requestsData));
    }
    if (url.pathname === '/api/friends/requests' && method === 'POST') {
      const body = options.body ? JSON.parse(options.body) : null;
      friendPostCalls.push({ url: url.toString(), body });
      if (postError) {
        return Promise.resolve(jsonResponse({ error: { code: 'REQUEST_FAILED', message: 'Could not send friend request' } }, 400));
      }
      return Promise.resolve(jsonResponse({ data: { id: 'req-new-1', status: 'pending' } }, 201));
    }
    if (url.pathname.startsWith('/api/friends/requests/') && url.pathname.endsWith('/accept') && method === 'POST') {
      friendPostCalls.push({ url: url.toString() });
      return Promise.resolve(jsonResponse({ data: { id: 'req-in-1', status: 'accepted' } }));
    }
    if (url.pathname.startsWith('/api/friends/requests/') && method === 'DELETE') {
      friendDeleteCalls.push({ url: url.toString() });
      return Promise.resolve(jsonResponse({ data: { status: 'deleted' } }));
    }
    if (url.pathname.startsWith('/api/friends/') && method === 'DELETE') {
      friendDeleteCalls.push({ url: url.toString() });
      return Promise.resolve(jsonResponse({ data: { status: 'removed' } }));
    }
    if (url.pathname === '/api/friends' && method === 'GET') {
      return Promise.resolve(jsonResponse(friendsData));
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
  const { default: Friends } = await server.ssrLoadModule('/src/pages/Friends.jsx');
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

  // Initialize session state to guest before first render test
  await session.initialize().catch(() => {});

  // 1. Unauthenticated navigation to /friends redirects to login
  await act(async () => {
    root.render(
      h(MemoryRouter, { key: 'step1', initialEntries: ['/friends'] },
        h(Routes, null,
          h(Route, { path: '/friends', element: h(RequireAuth, null, h(Friends)) }),
          h(Route, { path: '/login', element: h('div', null, 'Log in page') })
        )
      )
    );
  });
  assert.ok(document.body.textContent.includes('Log in page'), 'Unauthenticated /friends redirects to login');

  // Authenticate user
  await act(async () => {
    await session.authenticate('login', {});
  });

  // 2. Authenticated user sees Friends in main nav & navigation works
  await act(async () => root.render(
    h(MemoryRouter, { key: 'step2', initialEntries: ['/'] },
      h(Routes, null,
        h(Route, { element: h(Layout) },
          h(Route, { path: '/', element: h('div', null, 'Discover page') }),
          h(Route, { path: '/friends', element: h(Friends) })
        )
      )
    )
  ));

  const friendsNavLink = document.querySelector('a[href="/friends"]');
  assert.ok(friendsNavLink, 'Main navigation includes Friends link when authenticated');

  // 3. Render /friends page & Suggestions Tab
  await act(async () => root.render(
    h(MemoryRouter, { key: 'step3', initialEntries: ['/friends'] },
      h(Routes, null,
        h(Route, { path: '/friends', element: h(Friends) })
      )
    )
  ));

  assert.ok(document.body.textContent.includes('Friends'), 'Renders Friends heading');
  assert.ok(document.body.textContent.includes('Find readers who live between the same kinds of pages.'));

  const tabButtons = document.querySelectorAll('.friends-tabs button');
  assert.equal(tabButtons.length, 3, 'Renders 3 tabs: Suggestions, Friends, Requests');

  assert.ok(document.body.textContent.includes('Reader_Maria'), 'Renders candidate Reader_Maria');
  assert.ok(document.body.textContent.includes('You both read a lot of Thriller and Mystery'), 'Renders genre-based reason');

  // 4. Failed Add Friend interaction
  postError = true;
  const addBtn = document.querySelector('.add-friend-button');
  assert.ok(addBtn, 'Contains Add Friend button');
  await act(async () => {
    addBtn.click();
    await new Promise(r => setTimeout(r, 0));
  });
  assert.ok(document.body.textContent.includes('Could not send friend request'), 'Shows local inline error on failure');
  assert.ok(document.body.textContent.includes('Reader_Maria'), 'Candidate remains visible on failure');

  // 5. Successful Add Friend interaction
  postError = false;
  await act(async () => {
    addBtn.click();
    await new Promise(r => setTimeout(r, 0));
  });
  assert.equal(friendPostCalls.length, 2, 'Calls POST /api/friends/requests');
  assert.deepEqual(friendPostCalls[1].body, { userId: 'cand-1' });
  assert.ok(!document.body.textContent.includes('Reader_Maria'), 'Removes candidate from list on success');

  // 6. Friends Tab
  const friendsTabBtn = document.getElementById('tab-friends');
  await act(async () => {
    friendsTabBtn.click();
    await new Promise(r => setTimeout(r, 0));
  });
  assert.ok(document.body.textContent.includes('Friend_Alex'), 'Renders accepted friend Friend_Alex');
  const removeBtn = document.querySelector('.remove-friend-button');
  assert.ok(removeBtn, 'Contains Remove friend button');

  await act(async () => {
    removeBtn.click();
    await new Promise(r => setTimeout(r, 0));
  });
  assert.ok(friendDeleteCalls.some(c => c.url.includes('/api/friends/f-1')), 'Calls DELETE /api/friends/f-1');

  // 7. Requests Tab (Incoming & Sent)
  const requestsTabBtn = document.getElementById('tab-requests');
  await act(async () => {
    requestsTabBtn.click();
    await new Promise(r => setTimeout(r, 0));
  });
  assert.ok(document.body.textContent.includes('Incoming_Sam'), 'Renders incoming request Incoming_Sam');
  assert.ok(document.body.textContent.includes('Sent_Taylor'), 'Renders sent request Sent_Taylor');

  const acceptBtn = document.querySelector('.accept-request-button');
  await act(async () => {
    acceptBtn.click();
    await new Promise(r => setTimeout(r, 0));
  });
  assert.ok(friendPostCalls.some(c => c.url.includes('/api/friends/requests/req-in-1/accept')), 'Calls accept API endpoint');

  const cancelBtn = document.querySelector('.cancel-request-button');
  await act(async () => {
    cancelBtn.click();
    await new Promise(r => setTimeout(r, 0));
  });
  assert.ok(friendDeleteCalls.some(c => c.url.includes('/api/friends/requests/req-sent-1')), 'Calls cancel/delete request API endpoint');

  // 8. Empty state for insufficient reading history (meta.personalized === false)
  suggestionsData = {
    data: [],
    meta: { personalized: false, eligibleBooks: 2, minimumBooks: 5 },
  };

  const suggestionsTabBtn = document.getElementById('tab-suggestions');
  await act(async () => {
    suggestionsTabBtn.click();
    await new Promise(r => setTimeout(r, 0));
  });
  assert.ok(document.body.textContent.includes('We need a little more reading history first.'), 'Renders insufficient reading history title');
  assert.ok(document.querySelector('a[href="/my-books"]'), 'Renders link to My Books');
});
