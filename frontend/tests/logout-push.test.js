import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('logout removes the push subscription without blocking sign-out', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/' });
  dom.window.scrollTo = () => {};
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

  const calls = [];
  const endpoint = 'https://push.example.com/sub/logout-test';
  let refreshAllowed = false;
  let deleteStatus = 200;
  let mockSubscription = null;
  let unsubscribeCalled = 0;
  let unsubscribeError = null;
  let permissionRequests = 0;
  let subscriptionGate = null;
  let accessExpiresIn = 900;
  let loginToken = null;
  let refreshedToken = null;
  let allowRegister = false;
  let changeSessionOnDelete = false;
  const testPublicKey = 'BGouzo1xJ7_lwbhCB1DsNprRI7yu1PeBoyThiRRlIrwG_S9ZrJW7hkNOnH2_vAZH1U6zB-wTBFkbm5xStaPLKWk';

  function issueToken(expSeconds) {
    return `header.${btoa(JSON.stringify({ sub: 'user-logout-push', exp: expSeconds }))}.signature`;
  }

  function subscription() {
    return {
      endpoint,
      toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh', auth: 'auth' } }),
      unsubscribe: async () => {
        unsubscribeCalled += 1;
        if (unsubscribeError) throw unsubscribeError;
        mockSubscription = null;
        return true;
      },
    };
  }

  function installPushSupport() {
    permissionRequests = 0;
    dom.window.PushManager = function PushManager() {};
    globalThis.PushManager = dom.window.PushManager;
    dom.window.Notification = {
      permission: 'granted',
      requestPermission: async () => {
        permissionRequests += 1;
        return 'granted';
      },
    };
    globalThis.Notification = dom.window.Notification;
    const registration = {
      pushManager: {
        getSubscription: async () => {
          if (subscriptionGate) await subscriptionGate;
          return mockSubscription;
        },
        subscribe: async () => {
          mockSubscription = subscription();
          return mockSubscription;
        },
      },
    };
    dom.window.navigator.serviceWorker = {
      getRegistration: async () => registration,
      register: async () => {
        if (!allowRegister) throw new Error('register should not run during logout');
        return registration;
      },
      ready: Promise.resolve(registration),
    };
  }

  function removePushSupport() {
    delete dom.window.PushManager;
    delete globalThis.PushManager;
    delete dom.window.Notification;
    delete globalThis.Notification;
    delete dom.window.navigator.serviceWorker;
  }

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input, 'http://localhost:3000');
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    const authorization = options.headers?.Authorization ?? null;
    calls.push({ method, path: url.pathname, body, authorization });

    if (url.pathname === '/api/auth/login') {
      loginToken = issueToken(Math.floor(Date.now() / 1000) + accessExpiresIn);
      return Response.json({
        user: { id: 'user-logout-push', username: 'reader', email: 'reader@example.com' },
        accessToken: loginToken,
        expiresIn: 900,
      });
    }
    if (url.pathname === '/api/auth/refresh') {
      if (!refreshAllowed) {
        return Response.json({ error: { code: 'SESSION_EXPIRED', message: 'Signed out' } }, { status: 401 });
      }
      refreshedToken = issueToken(Math.floor(Date.now() / 1000) + 900);
      return Response.json({ accessToken: refreshedToken, expiresIn: 900 });
    }
    if (url.pathname === '/api/auth/me') {
      return Response.json({ user: { id: 'user-logout-push', username: 'reader', email: 'reader@example.com' } });
    }
    if (url.pathname === '/api/auth/logout') return new Response(null, { status: 204 });
    if (url.pathname === '/api/push/subscriptions' && method === 'DELETE') {
      if (changeSessionOnDelete) {
        let storageKey = null;
        for (let index = 0; index < dom.window.localStorage.length; index += 1) {
          const item = dom.window.localStorage.key(index);
          if (item?.startsWith('bookish:session:')) storageKey = item;
        }
        if (!storageKey) throw new Error('missing session marker');
        dom.window.localStorage.setItem(storageKey, JSON.stringify({ id: 'other-reader', signedOut: false }));
      }
      if (deleteStatus !== 200) {
        return Response.json({ error: { code: 'SERVER_ERROR', message: 'delete failed' } }, { status: deleteStatus });
      }
      return Response.json({ data: { status: 'unsubscribed' } });
    }
    if (url.pathname === '/api/push/public-key') {
      return Response.json({ data: { publicKey: testPublicKey } });
    }
    if (url.pathname === '/api/push/subscriptions' && method === 'POST') {
      return Response.json({ data: { status: 'subscribed' } }, { status: 201 });
    }
    if (url.pathname.startsWith('/api/notifications')) {
      return Response.json({ data: [], unreadCount: 0 });
    }
    return Response.json({ data: [] });
  };

  let server, root, session;
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

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { default: Layout } = await server.ssrLoadModule('/src/components/Layout.jsx');
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, Routes, Route } = await import('react-router-dom');

  await session.initialize();
  refreshAllowed = true;

  async function signIn() {
    await act(async () => {
      await session.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
    });
    assert.equal(session.getSnapshot().status, 'authenticated');
  }

  async function signOutSession() {
    await act(async () => { await session.logout(); });
  }

  function since(start) {
    return calls.slice(start);
  }

  // Active subscription: header sign-out removes it in the browser and on the server first.
  installPushSupport();
  mockSubscription = subscription();
  dom.window.Notification.permission = 'denied';
  await signIn();
  const token = (await session.credentials()).token;
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(
    h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null, h(Route, { path: '*', element: h(Layout) })),
    ),
  ));
  const signOut = Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Sign out');
  assert.ok(signOut, 'Header offers Sign out');
  const activeStart = calls.length;
  unsubscribeCalled = 0;
  let releaseSubscription;
  subscriptionGate = new Promise(resolve => { releaseSubscription = resolve; });
  let sawSigningOut = false;
  await act(async () => {
    signOut.click();
    for (let attempt = 0; attempt < 20 && !sawSigningOut; attempt += 1) {
      if (document.body.textContent.includes('Signing out…')) sawSigningOut = true;
      else await new Promise(resolve => setTimeout(resolve, 10));
    }
    releaseSubscription();
    subscriptionGate = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const slice = calls.slice(activeStart);
      if (slice.some(call => call.path === '/api/auth/logout') && session.getSnapshot().status === 'guest') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  });
  assert.equal(sawSigningOut, true, 'Disabled sign-out button says Signing out…');
  const activeCalls = since(activeStart);
  const deleted = activeCalls.find(call => call.path === '/api/push/subscriptions' && call.method === 'DELETE');
  const loggedOut = activeCalls.find(call => call.path === '/api/auth/logout');
  assert.ok(deleted, 'Sent DELETE /api/push/subscriptions');
  assert.equal(deleted.body.endpoint, endpoint);
  assert.equal(deleted.authorization, `Bearer ${token}`);
  assert.ok(loggedOut, 'Completed auth logout');
  assert.ok(activeCalls.indexOf(deleted) < activeCalls.indexOf(loggedOut), 'Server delete happens before the session is revoked');
  assert.equal(unsubscribeCalled, 1, 'Unsubscribed in the browser');
  assert.equal(permissionRequests, 0, 'Logout does not request notification permission');
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal((await session.credentials()).token, null);
  assert.ok(document.body.textContent.includes('Log in'));

  // No subscription, including when permission is denied and when push is unsupported.
  await signIn();
  mockSubscription = null;
  dom.window.Notification.permission = 'denied';
  unsubscribeCalled = 0;
  const noneStart = calls.length;
  await signOutSession();
  const noneCalls = since(noneStart);
  assert.equal(noneCalls.some(call => call.path === '/api/push/subscriptions'), false);
  assert.equal(unsubscribeCalled, 0);
  assert.equal(permissionRequests, 0);
  assert.ok(noneCalls.some(call => call.path === '/api/auth/logout'));
  assert.equal(session.getSnapshot().status, 'guest');

  await signIn();
  removePushSupport();
  const unsupportedStart = calls.length;
  await signOutSession();
  assert.equal(since(unsupportedStart).some(call => call.path === '/api/push/subscriptions'), false);
  assert.ok(since(unsupportedStart).some(call => call.path === '/api/auth/logout'));
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal((await session.credentials()).token, null);

  // Unsubscribe failure still signs the reader out.
  installPushSupport();
  await signIn();
  mockSubscription = subscription();
  deleteStatus = 500;
  unsubscribeError = new Error('browser unsubscribe failed');
  unsubscribeCalled = 0;
  const failStart = calls.length;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    await signOutSession();
  } finally {
    console.warn = originalWarn;
  }
  const failCalls = since(failStart);
  const failedDelete = failCalls.find(call => call.path === '/api/push/subscriptions' && call.method === 'DELETE');
  const failedLogout = failCalls.find(call => call.path === '/api/auth/logout');
  assert.ok(failedDelete, 'Still attempted the server delete');
  assert.ok(failedDelete.authorization?.startsWith('Bearer '));
  assert.equal(unsubscribeCalled, 1, 'Still attempted the browser unsubscribe');
  assert.ok(failedLogout, 'Auth logout still ran');
  assert.ok(failCalls.indexOf(failedDelete) < failCalls.indexOf(failedLogout));
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal((await session.credentials()).token, null);
  assert.ok(warnings.some(line => line.includes('delete failed')));
  assert.ok(warnings.some(line => line.includes('browser unsubscribe failed')));
  assert.equal(warnings.filter(line => line.includes('browser unsubscribe failed')).length, 1);
  assert.equal(warnings.filter(line => line.includes('delete failed')).length, 1);

  await act(async () => root.unmount());
  root = null;

  // Expired access token is refreshed before the server delete.
  accessExpiresIn = -60;
  deleteStatus = 200;
  unsubscribeError = null;
  mockSubscription = subscription();
  await signIn();
  const staleToken = loginToken;
  accessExpiresIn = 900;
  const expiredStart = calls.length;
  await signOutSession();
  const expiredCalls = since(expiredStart);
  const refreshed = expiredCalls.find(call => call.path === '/api/auth/refresh');
  const deletedAfterRefresh = expiredCalls.find(call => call.path === '/api/push/subscriptions' && call.method === 'DELETE');
  const loggedOutAfterRefresh = expiredCalls.find(call => call.path === '/api/auth/logout');
  assert.ok(refreshed, 'Refreshed the expired access token');
  assert.ok(deletedAfterRefresh, 'Deleted the push subscription after refresh');
  assert.ok(loggedOutAfterRefresh, 'Signed out after the delete');
  assert.ok(expiredCalls.indexOf(refreshed) < expiredCalls.indexOf(deletedAfterRefresh));
  assert.ok(expiredCalls.indexOf(deletedAfterRefresh) < expiredCalls.indexOf(loggedOutAfterRefresh));
  assert.equal(deletedAfterRefresh.authorization, `Bearer ${refreshedToken}`);
  assert.notEqual(deletedAfterRefresh.authorization, `Bearer ${staleToken}`);
  assert.equal(session.getSnapshot().status, 'guest');

  // getRegistration rejection cannot block sign-out.
  await signIn();
  dom.window.navigator.serviceWorker.getRegistration = async () => {
    throw new Error('registration failed');
  };
  const registrationStart = calls.length;
  await signOutSession();
  assert.equal(since(registrationStart).some(call => call.path === '/api/push/subscriptions'), false);
  assert.ok(since(registrationStart).some(call => call.path === '/api/auth/logout'));
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal((await session.credentials()).token, null);

  // Forced sign-out can no longer authenticate a server delete. It still drops the browser subscription.
  installPushSupport();
  await signIn();
  mockSubscription = subscription();
  refreshAllowed = false;
  unsubscribeCalled = 0;
  const forcedStart = calls.length;
  const forcedToken = (await session.credentials()).token;
  await act(async () => {
    assert.equal(await session.refresh(forcedToken), null);
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  refreshAllowed = true;
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal(unsubscribeCalled, 1, 'Forced sign-out unsubscribed in the browser');
  assert.equal(since(forcedStart).some(call => call.path === '/api/push/subscriptions'), false);

  // Another account taking over during the delete still signs this browser out.
  installPushSupport();
  await signIn();
  mockSubscription = subscription();
  unsubscribeCalled = 0;
  changeSessionOnDelete = true;
  const changedStart = calls.length;
  const changedWarnings = [];
  console.warn = (...args) => changedWarnings.push(args.map(String).join(' '));
  try {
    await signOutSession();
  } finally {
    console.warn = originalWarn;
    changeSessionOnDelete = false;
  }
  assert.ok(changedWarnings.some(line => line.includes('Your account changed')));
  assert.equal(unsubscribeCalled, 1);
  assert.ok(since(changedStart).some(call => call.path === '/api/push/subscriptions' && call.method === 'DELETE'));
  assert.ok(since(changedStart).some(call => call.path === '/api/auth/logout'));
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal((await session.credentials()).token, null);

  // A late unsubscribe must finish before subscribeToPush creates a replacement.
  const {
    subscribeToPush, unsubscribeFromPush, configurePushClient, checkSubscriptionStatus,
  } = await server.ssrLoadModule('/src/lib/push.js');
  const { api } = await server.ssrLoadModule('/src/lib/api.js');
  installPushSupport();
  allowRegister = true;
  await signIn();
  let releaseBrowserUnsub;
  mockSubscription = subscription();
  mockSubscription.unsubscribe = () => new Promise(resolve => {
    releaseBrowserUnsub = () => {
      unsubscribeCalled += 1;
      mockSubscription = null;
      resolve(true);
    };
  });
  dom.window.Notification.permission = 'default';
  permissionRequests = 0;
  const raceStart = calls.length;
  const hangingUnsub = unsubscribeFromPush();
  for (let attempt = 0; attempt < 50 && !releaseBrowserUnsub; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(typeof releaseBrowserUnsub, 'function');
  const subscribing = subscribeToPush();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(permissionRequests, 0, 'subscribe waits for the in-flight unsubscribe');
  assert.equal(since(raceStart).some(call => call.path === '/api/push/subscriptions' && call.method === 'POST'), false);
  releaseBrowserUnsub();
  await hangingUnsub;
  await subscribing;
  assert.equal(permissionRequests, 1);
  assert.ok(since(raceStart).some(call => call.path === '/api/push/subscriptions' && call.method === 'POST'));
  allowRegister = false;

  // An unconfigured push client reads as off and says so, without throwing from a status check.
  configurePushClient(null);
  const unconfiguredWarnings = [];
  console.warn = (...args) => unconfiguredWarnings.push(args.map(String).join(' '));
  try {
    assert.equal(await checkSubscriptionStatus(endpoint), false);
    assert.ok(unconfiguredWarnings.some(line => line.includes('not configured')));
    await assert.rejects(subscribeToPush(), /currently unavailable/);
  } finally {
    console.warn = originalWarn;
    configurePushClient(api);
  }
});
