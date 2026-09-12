import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Friends reader search debounces, ignores stale results, and updates relationships locally', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/friends' });
  const original = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(navigator, 'locks', { value: { request: (_key, _options, work) => work() } });
  const nativeFetch = globalThis.fetch;
  let server, root, session, resolveStaleSearch, searchCalls = 0;
  const response = (body, status = 200) => Response.json(body, { status });
  const readers = [
    { user: { id: 'none', username: 'Maria', profilePicture: null, bio: 'Thrillers and mysteries.' }, relationship: { status: 'none' } },
    { user: { id: 'out', username: 'Mario', profilePicture: null, bio: null }, relationship: { status: 'pending', direction: 'outgoing', requestId: 'request-out' } },
    { user: { id: 'in', username: 'Marina', profilePicture: null, bio: null }, relationship: { status: 'pending', direction: 'incoming', requestId: 'request-in' } },
    { user: { id: 'decline', username: 'Maribel', profilePicture: null, bio: null }, relationship: { status: 'pending', direction: 'incoming', requestId: 'request-decline' } },
    { user: { id: 'friend', username: 'Mara', profilePicture: null, bio: null }, relationship: { status: 'accepted', friendshipId: 'friendship-1' } },
  ];
  const setInputValue = (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let suggestionsData = {
    data: [{ user: readers[0].user, reason: { type: 'genres', genres: ['Mystery'], commonRatedBooks: 0, sharedBooks: 1 } }],
    meta: { personalized: true },
  };
  let friendsData = { data: [] };
  let requestsData = {
    data: {
      incoming: [
        { id: 'request-in', user: readers[2].user },
        { id: 'request-decline', user: readers[3].user },
      ],
      sent: [],
    },
  };

  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    session?.destroy(); await server?.close(); dom.window.close(); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });

  globalThis.fetch = (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || 'GET';
    if (url.pathname === '/api/auth/login') return Promise.resolve(response({ user: { id: 'reader', username: 'reader' }, accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`, expiresIn: 900 }));
    if (url.pathname === '/api/friends/suggestions') return Promise.resolve(response(suggestionsData));
    if (url.pathname === '/api/friends/requests' && method === 'GET') return Promise.resolve(response(requestsData));
    if (url.pathname === '/api/friends' && method === 'GET') return Promise.resolve(response(friendsData));
    if (url.pathname === '/api/friends/search') {
      searchCalls++;
      const q = url.searchParams.get('q');
      if (q === 'ma') return new Promise(resolve => { resolveStaleSearch = () => resolve(response({ data: [{ user: { id: 'stale', username: 'Old Maria', profilePicture: null, bio: null }, relationship: { status: 'none' } }] })); });
      if (q === 'none') return Promise.resolve(response({ data: [] }));
      if (q === 'err') return Promise.resolve(response({ error: { code: 'SEARCH_FAILED', message: 'Reader search is unavailable' } }, 500));
      return Promise.resolve(response({ data: readers }));
    }
    if (url.pathname === '/api/friends/requests' && method === 'POST') {
      suggestionsData = { data: [], meta: { personalized: true } };
      return Promise.resolve(response({ data: { id: 'request-new', status: 'pending' } }, 201));
    }
    if (url.pathname.endsWith('/accept') && method === 'POST') {
      requestsData = { data: { incoming: requestsData.data.incoming.filter(item => item.id !== 'request-in'), sent: [] } };
      friendsData = { data: [{ friendshipId: 'friendship-in', friend: readers[2].user, acceptedAt: '2026-09-12T00:00:00.000Z' }] };
      return Promise.resolve(response({ data: { id: 'friendship-in', status: 'accepted' } }));
    }
    if (url.pathname.startsWith('/api/friends/requests/') && method === 'DELETE') {
      if (url.pathname.endsWith('request-new')) suggestionsData = { data: [{ user: readers[0].user, reason: { type: 'genres', genres: ['Mystery'], commonRatedBooks: 0, sharedBooks: 1 } }], meta: { personalized: true } };
      if (url.pathname.endsWith('request-decline')) requestsData = { data: { incoming: requestsData.data.incoming.filter(item => item.id !== 'request-decline'), sent: [] } };
      return Promise.resolve(response({ data: { status: 'deleted' } }));
    }
    return Promise.resolve(response({ data: [] }));
  };

  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const { default: Friends } = await server.ssrLoadModule('/src/pages/Friends.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, useLocation } = await import('react-router-dom');
  function Location() { return h('output', { id: 'location' }, useLocation().pathname); }
  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/friends'] }, h(Friends), h(Location))));

  const input = document.querySelector('#reader-search-input');
  assert.ok(input, 'reader search is present above the tabs');
  assert.ok(input.compareDocumentPosition(document.querySelector('.friends-tabs')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(searchCalls, 0, 'blank search makes no request');
  await act(async () => { setInputValue(input, 'm'); await pause(300); });
  assert.equal(searchCalls, 0, 'a one-character search makes no request');

  await act(async () => { setInputValue(input, 'ma'); await pause(300); });
  await act(async () => { setInputValue(input, 'mar'); await pause(300); });
  assert.ok(document.body.textContent.includes('Maria'));
  await act(async () => { resolveStaleSearch(); await pause(0); });
  assert.ok(!document.body.textContent.includes('Old Maria'), 'older slow results cannot replace the latest query');

  const clickSearchAction = async (username, label) => {
    const card = [...document.querySelectorAll('.reader-search-result')].find(item => item.querySelector('h3')?.textContent === username);
    const button = [...card.querySelectorAll('button')].find(item => item.textContent.trim() === label);
    assert.ok(button, `${label} action is available for ${username}`);
    await act(async () => { button.click(); await pause(0); });
  };
  await clickSearchAction('Maria', 'Add Friend');
  assert.ok(document.body.textContent.includes('Request sent'));
  assert.equal([...document.querySelectorAll('.friends-tab-panel h3')].filter(item => item.textContent === 'Maria').length, 0, 'the suggested reader disappears after a search request succeeds');
  await clickSearchAction('Maria', 'Cancel');
  assert.ok(document.body.textContent.includes('Add Friend'));
  const requestsTab = document.getElementById('tab-requests');
  await act(async () => { requestsTab.click(); await pause(0); });
  await clickSearchAction('Maribel', 'Decline');
  assert.ok(!document.getElementById('panel-requests').textContent.includes('Maribel'), 'the visible requests list refreshes after a search decline');
  const friendsTab = document.getElementById('tab-friends');
  await act(async () => { friendsTab.click(); await pause(0); });
  await clickSearchAction('Marina', 'Accept');
  assert.ok(document.getElementById('panel-friends').textContent.includes('Marina'), 'the visible friends list refreshes after a search acceptance');
  assert.ok(document.body.textContent.includes('✓ Friends'));
  assert.equal(document.querySelector('#location').textContent, '/friends', 'search actions do not navigate away');

  await act(async () => { setInputValue(input, 'none'); await pause(300); });
  assert.ok(document.body.textContent.includes('No readers found.'));
  await act(async () => { setInputValue(input, 'err'); await pause(300); });
  assert.ok(document.body.textContent.includes('Reader search is unavailable'));
});
