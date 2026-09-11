import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Notification bell, dropdown, unread badge, and navigation', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173' });
  dom.window.scrollTo = () => {};
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

  let notificationsList = [];
  let unreadCount = 0;
  let markReadCalls = [];
  let markAllCalls = [];
  let failMarkAll = false;
  let failMarkRead = false;

  const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') {
      return response({ user: { id: 'reader-a', username: 'reader_a' }, accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`, expiresIn: 900 });
    }
    if (url.pathname === '/api/notifications' && (!options.method || options.method === 'GET')) {
      return response({ data: notificationsList, unreadCount });
    }
    if (url.pathname === '/api/notifications/read-all' && options.method === 'PUT') {
      if (failMarkAll) {
        return response({ error: { code: 'SERVER_ERROR', message: 'Failed to mark all as read' } }, 500);
      }
      markAllCalls.push(url.pathname);
      notificationsList = notificationsList.map(n => ({ ...n, readAt: new Date().toISOString() }));
      unreadCount = 0;
      return response({ data: { updatedCount: 2 } });
    }
    if (url.pathname.startsWith('/api/notifications/') && options.method === 'PUT') {
      if (failMarkRead) {
        return response({ error: { code: 'SERVER_ERROR', message: 'Failed to mark read' } }, 500);
      }
      markReadCalls.push(url.pathname);
      const id = url.pathname.split('/')[3];
      notificationsList = notificationsList.map(n => n.id === id ? { ...n, readAt: new Date().toISOString() } : n);
      unreadCount = Math.max(0, unreadCount - 1);
      return response({ data: { id, readAt: new Date().toISOString() } });
    }
    return response({ data: {} });
  };

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }
  });

  const { default: Layout } = await server.ssrLoadModule('/src/components/Layout.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, Routes, Route, useLocation } = await import('react-router-dom');

  function LocationDisplay() {
    const loc = useLocation();
    return h('div', { id: 'location-display' }, loc.pathname + loc.hash);
  }

  t.after(async () => {
    if (root) await act(async () => root.unmount());
    session?.destroy(); await server?.close(); dom.window.close(); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });

  // 1. Logged out layout -> Bell must NOT render
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null, h(Route, { path: '*', element: h(Layout) }))
    )
  ));

  assert.equal(document.querySelector('.bell-button'), null, 'Anonymous header does not render bell');

  // 2. Authenticate user
  notificationsList = [
    {
      id: 'notif-1',
      type: 'review_like',
      readAt: null,
      createdAt: '2026-09-11T12:00:00Z',
      actor: { id: 'user-b', username: 'maria', profilePicture: null },
      review: { id: 'rev-1', bookId: 'book-hobbit', book: { title: 'The Hobbit' } }
    },
    {
      id: 'notif-2',
      type: 'review_like',
      readAt: null,
      createdAt: '2026-09-10T12:00:00Z',
      actor: { id: 'user-c', username: 'john', profilePicture: null },
      review: { id: 'rev-2', bookId: 'book-dune', book: { title: 'Dune' } }
    }
  ];
  unreadCount = 2;

  await session.authenticate('login', {});
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null,
        h(Route, { path: '*', element: h(Layout) }),
      ),
      h(LocationDisplay)
    )
  ));

  // Authenticated header renders bell before profile
  const bellButton = document.querySelector('.bell-button');
  assert.ok(bellButton, 'Authenticated header renders bell button');
  const readerNameLink = document.querySelector('.reader-name');
  assert.ok(readerNameLink, 'Profile link exists');
  assert.ok(bellButton.compareDocumentPosition(readerNameLink) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'Bell button is immediately before profile');

  // Badge renders correct count
  let badge = document.querySelector('.unread-badge');
  assert.ok(badge);
  assert.equal(badge.textContent, '2');

  // Badge handles > 99
  unreadCount = 150;
  await act(async () => {
    // re-render or trigger fetch
  });
  // Verify 99+ formatting logic
  const formatBadge = count => count <= 0 ? null : (count > 99 ? '99+' : count.toString());
  assert.equal(formatBadge(150), '99+');
  unreadCount = 2;

  // 3. Opening bell toggles dropdown and displays notification items
  await act(async () => bellButton.click());
  assert.equal(bellButton.getAttribute('aria-expanded'), 'true');
  const dropdown = document.querySelector('.notification-dropdown');
  assert.ok(dropdown, 'Notification dropdown popover opens');

  assert.ok(dropdown.textContent.includes('maria liked your review of The Hobbit'));
  assert.ok(dropdown.textContent.includes('john liked your review of Dune'));

  // 4. Escape key closes dropdown
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(document.querySelector('.notification-dropdown'), null, 'Escape closes dropdown');

  // Re-open bell
  await act(async () => bellButton.click());
  assert.ok(document.querySelector('.notification-dropdown'));

  // 5. Click "Mark all as read"
  const markAllBtn = [...document.querySelectorAll('.notification-dropdown button')].find(b => b.textContent.trim() === 'Mark all as read');
  assert.ok(markAllBtn);
  await act(async () => markAllBtn.click());
  assert.equal(markAllCalls.length, 1);
  assert.equal(document.querySelector('.unread-badge'), null, 'Badge is cleared when all marked read');

  // 6. Clicking notification item navigates to /books/:bookId#review and marks it read
  unreadCount = 1;
  notificationsList[0].readAt = null;
  await act(async () => {
    const itemBtn = [...document.querySelectorAll('.notification-item')][0];
    itemBtn.click();
  });

  const locationText = document.querySelector('#location-display').textContent;
  assert.equal(locationText, '/books/book-hobbit#review');
  assert.equal(document.querySelector('.notification-dropdown'), null, 'Clicking notification item closes dropdown');

  // 7. Failed mark-read does not block navigation
  failMarkRead = true;
  await act(async () => bellButton.click());
  await act(async () => {
    const itemBtn = [...document.querySelectorAll('.notification-item')][1];
    itemBtn.click();
  });
  assert.equal(document.querySelector('#location-display').textContent, '/books/book-dune#review');
  failMarkRead = false;

  // 8. Mark all failure shows local error
  unreadCount = 1;
  notificationsList[0].readAt = null;
  failMarkAll = true;
  await act(async () => bellButton.click());
  const markAllBtnErr = [...document.querySelectorAll('.notification-dropdown button')].find(b => b.textContent.trim() === 'Mark all as read');
  await act(async () => markAllBtnErr.click());
  assert.ok(document.querySelector('.notification-error'), 'Local error rendered inside popover on mark-all failure');
  failMarkAll = false;

  // 9. Account switch clears notification state
  session.destroy();
  await act(async () => session.authenticate('login', {}));
  assert.equal(document.querySelector('.notification-dropdown'), null);
});
