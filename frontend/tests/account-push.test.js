import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Account page: browser push notifications UI states and interactions', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/account' });
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

  let server, root, session;
  const apiCalls = [];

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

  const testPublicKey = 'BGouzo1xJ7_lwbhCB1DsNprRI7yu1PeBoyThiRRlIrwG_S9ZrJW7hkNOnH2_vAZH1U6zB-wTBFkbm5xStaPLKWk';
  const testEndpoint = 'https://push.example.com/sub/account-test';

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    apiCalls.push({ method, path: url.pathname, body });

    if (url.pathname === '/api/auth/login') {
      const payload = btoa(JSON.stringify({ sub: 'user-push-1', exp: Date.now() / 1000 + 900 }));
      return Response.json({
        user: { id: 'user-push-1', username: 'pushreader', email: 'push@example.com' },
        accessToken: `header.${payload}.signature`,
        expiresIn: 900,
      });
    }
    if (url.pathname === '/api/push/public-key') {
      return Response.json({ data: { publicKey: testPublicKey } });
    }
    if (url.pathname === '/api/push/subscriptions' && method === 'POST') {
      return Response.json({ data: { status: 'subscribed' } }, { status: 201 });
    }
    if (url.pathname === '/api/push/subscriptions' && method === 'DELETE') {
      return Response.json({ data: { status: 'unsubscribed' } });
    }
    return Response.json({ data: [] });
  };

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  const { default: Account } = await server.ssrLoadModule('/src/pages/Account.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');

  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));

  // ==========================================
  // 1. Unsupported browser state
  // ==========================================
  // Neither Notification nor PushManager nor serviceWorker are configured on window yet.
  await act(async () => root.render(h(Account, { key: 'step1' })));
  await act(async () => { await new Promise(r => setTimeout(r, 10)); });

  assert.ok(
    document.body.textContent.includes("Browser notifications aren't supported on this device."),
    'Renders unsupported message when browser lacks push APIs'
  );

  // ==========================================
  // Setup Push API mocks on window/navigator
  // ==========================================
  let requestPermissionCalled = false;
  let mockSubscription = null;
  let unsubscribeCalled = false;

  const mockPushManager = {
    getSubscription: async () => mockSubscription,
    subscribe: async options => {
      mockSubscription = {
        endpoint: testEndpoint,
        options,
        toJSON: () => ({
          endpoint: testEndpoint,
          keys: {
            p256dh: 'mock-p256dh',
            auth: 'mock-auth',
          },
        }),
        unsubscribe: async () => {
          unsubscribeCalled = true;
          mockSubscription = null;
          return true;
        },
      };
      return mockSubscription;
    },
  };

  const mockRegistration = {
    pushManager: mockPushManager,
  };

  dom.window.PushManager = function () {};
  globalThis.PushManager = dom.window.PushManager;

  dom.window.Notification = {
    permission: 'default',
    requestPermission: async () => {
      requestPermissionCalled = true;
      dom.window.Notification.permission = 'granted';
      return 'granted';
    },
  };
  globalThis.Notification = dom.window.Notification;

  dom.window.navigator.serviceWorker = {
    getRegistration: async () => mockRegistration,
    register: async () => mockRegistration,
    ready: Promise.resolve(mockRegistration),
  };
  globalThis.navigator = dom.window.navigator;

  // ==========================================
  // 2. Permission denied state
  // ==========================================
  dom.window.Notification.permission = 'denied';
  await act(async () => root.render(h(Account, { key: 'step2' })));
  await act(async () => { await new Promise(r => setTimeout(r, 10)); });

  assert.ok(
    document.body.textContent.includes('Notifications are blocked in your browser settings.'),
    'Renders blocked message when Notification.permission is denied'
  );
  assert.equal(requestPermissionCalled, false, 'Did not call requestPermission on mount');

  // ==========================================
  // 3. Permission is NOT requested automatically on mount (default state)
  // ==========================================
  dom.window.Notification.permission = 'default';
  requestPermissionCalled = false;
  mockSubscription = null;

  await act(async () => root.render(h(Account, { key: 'step3' })));
  await act(async () => { await new Promise(r => setTimeout(r, 10)); });

  assert.equal(requestPermissionCalled, false, 'Permission is NOT requested automatically on page load');
  assert.ok(
    document.body.textContent.includes('Get notified when someone sends you a friend request.'),
    'Renders prompt text in default disabled state'
  );

  const enableBtn = Array.from(document.querySelectorAll('button')).find(
    b => b.textContent.trim() === 'Enable notifications'
  );
  assert.ok(enableBtn, 'Offers explicit Enable notifications button');

  // ==========================================
  // 4, 5, 6. Enable button requests permission, subscribes, posts to backend, shows enabled state
  // ==========================================
  await act(async () => {
    enableBtn.click();
    await new Promise(r => setTimeout(r, 10));
  });

  assert.equal(requestPermissionCalled, true, 'Clicking Enable notifications requested permission');
  assert.ok(
    apiCalls.some(c => c.path === '/api/push/public-key'),
    'Fetched VAPID public key from backend'
  );
  const subCall = apiCalls.find(c => c.path === '/api/push/subscriptions' && c.method === 'POST');
  assert.ok(subCall, 'Posted subscription to backend');
  assert.equal(subCall.body.endpoint, testEndpoint);
  assert.equal(subCall.body.keys.p256dh, 'mock-p256dh');
  assert.equal(subCall.body.keys.auth, 'mock-auth');

  assert.ok(
    document.body.textContent.includes('Browser notifications are enabled on this device.'),
    'Enabled state is displayed after subscribing'
  );

  const disableBtn = Array.from(document.querySelectorAll('button')).find(
    b => b.textContent.trim() === 'Disable notifications'
  );
  assert.ok(disableBtn, 'Offers Disable notifications button when subscribed');

  // ==========================================
  // 7. Disable unsubscribes locally and removes backend subscription
  // ==========================================
  unsubscribeCalled = false;
  await act(async () => {
    disableBtn.click();
    await new Promise(r => setTimeout(r, 10));
  });

  assert.equal(unsubscribeCalled, true, 'Unsubscribed from PushManager locally');
  const unsubCall = apiCalls.find(c => c.path === '/api/push/subscriptions' && c.method === 'DELETE');
  assert.ok(unsubCall, 'Sent DELETE /api/push/subscriptions to backend');
  assert.equal(unsubCall.body.endpoint, testEndpoint);

  assert.ok(
    document.body.textContent.includes('Get notified when someone sends you a friend request.'),
    'Reverts to prompt state after disabling'
  );
  assert.ok(
    Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Enable notifications'),
    'Offers Enable notifications button again'
  );
});
