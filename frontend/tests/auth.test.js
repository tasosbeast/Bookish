import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/lib/session.js';
import { createApi } from '../src/lib/client.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const failure = (status, code) => json({ error: { code, message: code } }, status);
const jwt = exp => `header.${btoa(JSON.stringify({ exp }))}.signature`;
function environment() {
  const values = new Map();
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  let tail = Promise.resolve();
  const locks = { request: (_name, _options, work) => {
    const result = tail.then(work); tail = result.catch(() => {}); return result;
  } };
  let active = 0, maximum = 0, refreshes = 0;
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/me')) return json({ user: { id: 'reader', username: 'reader' } });
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (url.endsWith('/logout')) return new Response(null, { status: 204 });
    if (url.endsWith('/refresh')) refreshes++;
    return json({ accessToken: jwt(Date.now() / 1000 + 900), expiresIn: 900, user: { id: 'reader' } });
  };
  const make = extra => createSession({ baseUrl: '/api', storage, locks, fetcher, ...extra });
  return { make, calls, values, get maximum() { return maximum; }, get refreshes() { return refreshes; } };
}

test('one tab coalesces refresh and restores the safe profile with CSRF and credentials', async () => {
  const env = environment(), session = env.make();
  await Promise.all([session.initialize(), session.refresh(), session.refresh()]);
  assert.equal(env.refreshes, 1);
  assert.equal(session.getSnapshot().user.username, 'reader');
  assert.equal(env.calls[0].options.headers['X-Bookish-CSRF'], '1');
  assert.equal(env.calls[0].options.credentials, 'include');
  assert.ok(env.calls[1].options.headers.Authorization.startsWith('Bearer '));
});

test('tabs serialize rotating cookies; logout prevents another tab restoring the session', async () => {
  const env = environment(), first = env.make(), second = env.make();
  await Promise.all([first.initialize(), second.initialize()]);
  assert.equal(env.refreshes, 2);
  assert.equal(env.maximum, 1);
  await first.logout();
  assert.equal((await second.credentials()).token, null);
  assert.equal(await second.refresh(), null);
  assert.equal(env.refreshes, 2);
  await first.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  assert.ok((await second.credentials()).token);
  for (const value of env.values.values()) {
    assert.deepEqual(Object.keys(JSON.parse(value)).sort(), ['id', 'signedOut']);
    assert.ok(!value.includes('password') && !value.includes('signature'));
  }
});

test('logout storage event clears an idle tab and failed logout stays signed out', async () => {
  const env = environment(); let storageEvent;
  const idle = env.make({ listenStorage: callback => { storageEvent = callback; return () => {}; } });
  const first = env.make({ fetcher: async url => {
    if (url.endsWith('/logout')) throw new TypeError('offline');
    return json({ accessToken: jwt(Date.now() / 1000 + 900), user: { id: 'reader' } });
  } });
  await idle.initialize();
  await assert.rejects(first.logout(), /offline/);
  storageEvent({ key: 'bookish:session:/api' });
  assert.equal(idle.getSnapshot().status, 'guest');
  assert.equal((await idle.credentials()).token, null);
});

test('unsupported coordination fails closed; a refresh network error is not a logout', async () => {
  const env = environment(), unsupported = env.make({ locks: null });
  await unsupported.initialize();
  assert.equal(unsupported.getSnapshot().error.code, 'BROWSER_UNSUPPORTED');
  assert.equal(env.calls.length, 0);
  let offline = false;
  const session = env.make({ fetcher: async url => {
    if (offline) throw new TypeError('offline');
    return url.endsWith('/me') ? json({ user: { id: 'reader' } }) : json({ accessToken: jwt(Date.now() / 1000 + 900) });
  } });
  await session.initialize(); const { token } = await session.credentials(); offline = true;
  await assert.rejects(session.refresh(token), /offline/);
  assert.equal(session.getSnapshot().status, 'authenticated');
  assert.equal(session.getSnapshot().user.id, 'reader');
});

test('expiration checks still recognize an old token after another request refreshed it', async () => {
  let clock = 10000;
  const env = environment();
  const session = env.make({ now: () => clock, fetcher: async url => url.endsWith('/me')
    ? json({ user: { id: 'reader' } }) : json({ accessToken: jwt(clock / 1000 + 20) }) });
  await session.initialize(); const old = (await session.credentials()).token;
  clock = 31000;
  const current = await session.refresh(old);
  assert.notEqual(current, old);
  assert.equal(session.isExpired(old), true);
  assert.equal(await session.refresh(old), current);
});

function clientFixture(responses, { expired = true, changed = false } = {}) {
  let refreshes = 0, invalidations = 0, calls = 0;
  const session = {
    credentials: async () => ({ token: 'old', marker: 'account' }),
    accountUnchanged: () => !changed,
    isExpired: () => expired,
    refresh: async () => { refreshes++; return 'new'; },
    invalidate: () => { invalidations++; },
  };
  const api = createApi({ baseUrl: '/api', session, fetcher: async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${calls ? 'new' : 'old'}`);
    return responses[calls++];
  } });
  return { api, get counts() { return { refreshes, invalidations, calls }; } };
}

test('expired token retries exactly once following refresh', async () => {
  const f = clientFixture([failure(401, 'INVALID_TOKEN'), json({ data: 'ok' })]);
  assert.deepEqual(await f.api('/books'), { data: 'ok' });
  assert.deepEqual(f.counts, { refreshes: 1, invalidations: 0, calls: 2 });
  const failed = clientFixture([failure(401, 'INVALID_TOKEN'), failure(401, 'INVALID_TOKEN')]);
  await assert.rejects(failed.api('/books'), { status: 401 });
  assert.deepEqual(failed.counts, { refreshes: 1, invalidations: 1, calls: 2 });
});

test('validation, server errors, revoked sessions and unexpired invalid tokens never refresh', async () => {
  for (const [status, code, expired] of [[400, 'VALIDATION_ERROR', true], [500, 'INTERNAL_ERROR', true], [401, 'SESSION_EXPIRED', true], [401, 'INVALID_TOKEN', false]]) {
    const f = clientFixture([failure(status, code)], { expired });
    await assert.rejects(f.api('/books'), { status });
    assert.equal(f.counts.refreshes, 0);
    assert.equal(f.counts.calls, 1);
    assert.equal(f.counts.invalidations, status === 401 ? 1 : 0);
  }
});

test('account changes discard in-flight results and cancelled requests do not send', async () => {
  const f = clientFixture([json({ data: 'private' })], { changed: true });
  await assert.rejects(f.api('/user-books'), { code: 'SESSION_CHANGED' });
  const cancelled = clientFixture([]), controller = new AbortController(); controller.abort();
  await assert.rejects(cancelled.api('/books', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(cancelled.counts.calls, 0);
});

test('logout cleanup runs while authenticated and cannot block sign-out', async () => {
  const env = environment();
  let sawToken = false;
  const session = env.make({
    beforeLogout: async () => {
      assert.equal(env.calls.some(call => call.url.endsWith('/logout')), false);
      const creds = await session.credentials();
      sawToken = Boolean(creds.token);
      assert.equal(session.getSnapshot().status, 'authenticated');
    },
  });
  await session.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  await session.logout();
  assert.equal(sawToken, true);
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal((await session.credentials()).token, null);
  assert.ok(env.calls.some(call => call.url.endsWith('/logout')));

  const failing = env.make({
    beforeLogout: async () => { throw new Error('unsubscribe failed'); },
  });
  await failing.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await failing.logout();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(failing.getSnapshot().status, 'guest');
  assert.equal((await failing.credentials()).token, null);
  assert.equal(warnings.length, 0);
  assert.ok(env.calls.filter(call => call.url.endsWith('/logout')).length >= 2);
});

test('hung push cleanup still signs out', { timeout: 2000 }, async () => {
  const env = environment();
  const session = env.make({
    logoutCleanupMs: 30,
    beforeLogout: () => new Promise(() => {}),
  });
  await session.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  const started = Date.now();
  await session.logout();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `logout waited ${elapsed}ms`);
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal((await session.credentials()).token, null);
  assert.ok(env.calls.some(call => call.url.endsWith('/logout')));
});

test('logout aborts a refresh started by cleanup and still signs out', { timeout: 2000 }, async () => {
  let nowMs = 10_000;
  let hangRefresh = false;
  const calls = [];
  const env = environment();
  const session = env.make({
    now: () => nowMs,
    logoutCleanupMs: 40,
    fetcher: async (url, options) => {
      calls.push(url);
      if (url.endsWith('/logout')) return new Response(null, { status: 204 });
      if (url.endsWith('/me')) return json({ user: { id: 'reader', username: 'reader' } });
      if (url.endsWith('/refresh')) {
        if (!hangRefresh) return failure(401, 'SESSION_EXPIRED');
        return new Promise((resolve, reject) => {
          const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return json({ accessToken: jwt(nowMs / 1000 + 10), expiresIn: 10, user: { id: 'reader', username: 'reader' } });
    },
    beforeLogout: ({ signal } = {}) => session.credentials({ signal }),
  });
  await session.initialize();
  await session.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  hangRefresh = true;
  nowMs += 20_000;
  const started = Date.now();
  await session.logout();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `logout waited ${elapsed}ms`);
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal(session.getSnapshot().error, null);
  const logoutAt = calls.findIndex(url => url.endsWith('/logout'));
  const refreshAt = calls.findLastIndex(url => url.endsWith('/refresh'));
  assert.ok(refreshAt >= 0 && logoutAt > refreshAt);
});

test('forced sign-out drops local push state without treating explicit logout as forced', async () => {
  const env = environment();
  let drops = 0;
  const session = env.make({
    onSignedOut: () => { drops += 1; },
    fetcher: async url => {
      if (url.endsWith('/refresh')) return failure(401, 'SESSION_EXPIRED');
      if (url.endsWith('/me')) return json({ user: { id: 'reader', username: 'reader' } });
      if (url.endsWith('/logout')) return new Response(null, { status: 204 });
      return json({ accessToken: jwt(Date.now() / 1000 + 900), expiresIn: 900, user: { id: 'reader', username: 'reader' } });
    },
  });
  await session.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  assert.equal(await session.refresh((await session.credentials()).token), null);
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal(drops, 1);
  await session.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  session.invalidate((await session.credentials()).token);
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal(drops, 2);
  await session.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  await session.logout();
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal(drops, 2);
});

test('aborting one refresh waiter leaves the shared refresh running', async () => {
  let release;
  const env = environment();
  const session = env.make({
    fetcher: async (url, options) => {
      if (url.endsWith('/refresh')) {
        await new Promise((resolve, reject) => {
          release = resolve;
          const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener('abort', abort, { once: true });
        });
        return json({ accessToken: jwt(Date.now() / 1000 + 900), expiresIn: 900 });
      }
      if (url.endsWith('/me')) return json({ user: { id: 'reader', username: 'reader' } });
      return json({ accessToken: jwt(Date.now() / 1000 + 900), expiresIn: 900, user: { id: 'reader', username: 'reader' } });
    },
  });
  await session.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  const token = (await session.credentials()).token;
  const first = session.refresh(token);
  await new Promise(resolve => setTimeout(resolve, 10));
  const controller = new AbortController();
  const second = session.refresh(token, controller.signal);
  controller.abort();
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(session.getSnapshot().status, 'authenticated');
  release();
  const renewed = await first;
  assert.equal(session.getSnapshot().status, 'authenticated');
  assert.ok(renewed);
  assert.notEqual(renewed, token);
});

test('logout returns while another request still holds the auth lock', { timeout: 2000 }, async () => {
  let holdLogin = false;
  let unblock;
  const calls = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  const env = environment();
  const session = env.make({
    logoutLockWaitMs: 40,
    fetcher: async url => {
      calls.push(url);
      if (url.endsWith('/login') && holdLogin) await new Promise(resolve => { unblock = resolve; });
      if (url.endsWith('/logout')) return new Response(null, { status: 204 });
      if (url.endsWith('/me')) return json({ user: { id: 'reader', username: 'reader' } });
      if (url.endsWith('/refresh')) return json({ accessToken: jwt(Date.now() / 1000 + 900), expiresIn: 900 });
      return json({ accessToken: jwt(Date.now() / 1000 + 900), expiresIn: 900, user: { id: 'reader', username: 'reader' } });
    },
  });
  try {
    await session.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
    holdLogin = true;
    const pendingLogin = session.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(typeof unblock, 'function');
    const started = Date.now();
    await session.logout();
    assert.ok(Date.now() - started < 1000);
    assert.equal(session.getSnapshot().status, 'guest');
    assert.equal(calls.some(url => url.endsWith('/logout')), false);
    assert.ok(warnings.some(line => line.includes('already signed out')));
    unblock();
    await pendingLogin;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(session.getSnapshot().status, 'guest');
    assert.ok(calls.some(url => url.endsWith('/logout')));
  } finally {
    console.warn = originalWarn;
    unblock?.();
  }
});

test('a hung refresh before logout still yields guest status immediately', { timeout: 2000 }, async () => {
  let release;
  const calls = [];
  const env = environment();
  const session = env.make({
    fetcher: async url => {
      calls.push(url);
      if (url.endsWith('/refresh')) {
        await new Promise(resolve => { release = resolve; });
        return json({ accessToken: jwt(Date.now() / 1000 + 900), expiresIn: 900 });
      }
      if (url.endsWith('/me')) return json({ user: { id: 'reader', username: 'reader' } });
      if (url.endsWith('/logout')) return new Response(null, { status: 204 });
      return json({ accessToken: jwt(Date.now() / 1000 + 900), expiresIn: 900, user: { id: 'reader', username: 'reader' } });
    },
  });
  await session.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  const hung = session.refresh((await session.credentials()).token);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(session.getSnapshot().status, 'authenticated');
  const pending = session.logout();
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal(session.getSnapshot().user, null);
  assert.equal(calls.some(url => url.endsWith('/logout')), false);
  release();
  await hung.catch(() => {});
  await pending;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal(session.getSnapshot().user, null);
  assert.ok(calls.some(url => url.endsWith('/logout')));
});

test('refresh network and server errors do not drop the browser subscription', async () => {
  let mode = 'ok';
  let drops = 0;
  const env = environment();
  const session = env.make({
    onSignedOut: () => { drops += 1; },
    fetcher: async url => {
      if (url.endsWith('/refresh')) {
        if (mode === 'offline') throw new TypeError('offline');
        if (mode === '500') return failure(500, 'SERVER_ERROR');
        return json({ accessToken: jwt(Date.now() / 1000 + 900), expiresIn: 900 });
      }
      if (url.endsWith('/me')) return json({ user: { id: 'reader', username: 'reader' } });
      if (url.endsWith('/logout')) return new Response(null, { status: 204 });
      return json({ accessToken: jwt(Date.now() / 1000 + 900), expiresIn: 900, user: { id: 'reader', username: 'reader' } });
    },
  });
  await session.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  const token = (await session.credentials()).token;
  mode = 'offline';
  await assert.rejects(session.refresh(token), /offline/);
  assert.equal(session.getSnapshot().status, 'authenticated');
  assert.equal(drops, 0);
  mode = '500';
  await assert.rejects(session.refresh(token), /SERVER_ERROR/);
  assert.equal(session.getSnapshot().status, 'authenticated');
  assert.equal(drops, 0);
});

test('a revoked session discovered while restoring drops the browser subscription once', async () => {
  let drops = 0;
  const env = environment();
  const session = env.make({
    onSignedOut: () => { drops += 1; },
    fetcher: async url => {
      if (url.endsWith('/refresh')) return failure(401, 'SESSION_EXPIRED');
      if (url.endsWith('/me')) return json({ user: { id: 'reader', username: 'reader' } });
      return json({ accessToken: jwt(Date.now() / 1000 + 900), expiresIn: 900, user: { id: 'reader' } });
    },
  });
  assert.equal(session.getSnapshot().status, 'restoring');
  await session.initialize();
  assert.equal(session.getSnapshot().status, 'guest');
  assert.equal(drops, 1);
  await session.initialize();
  assert.equal(drops, 1);
});

test('another tab signing out drops the local subscription once', async () => {
  const env = environment();
  let storageEvent;
  let drops = 0;
  const idle = env.make({
    listenStorage: callback => { storageEvent = callback; return () => {}; },
    onSignedOut: () => { drops += 1; },
  });
  const other = env.make();
  await idle.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  await other.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  await other.logout();
  assert.equal(drops, 0);
  storageEvent({ key: 'bookish:session:/api' });
  assert.equal(idle.getSnapshot().status, 'guest');
  assert.equal(drops, 1);
  storageEvent({ key: 'bookish:session:/api' });
  assert.equal(drops, 1);
});

test('simulated page reload restores authentication from refresh cookie without persisting tokens', async () => {
  const env = environment();
  const session1 = env.make();
  await session1.authenticate('login', { email: 'reader@example.com', password: 'fixture' });
  assert.equal(session1.getSnapshot().status, 'authenticated');
  assert.equal(session1.getSnapshot().user.id, 'reader');

  const creds = await session1.credentials();
  assert.ok(creds.token);
  for (const value of env.values.values()) {
    assert.ok(!value.includes(creds.token));
  }

  const session2 = env.make();
  assert.equal(session2.getSnapshot().status, 'restoring');
  await session2.initialize();
  assert.equal(session2.getSnapshot().status, 'authenticated');
  assert.equal(session2.getSnapshot().user.id, 'reader');

  const failedEnv = environment();
  const sessionFail = failedEnv.make({
    fetcher: async url => {
      if (url.endsWith('/refresh')) return failure(401, 'UNAUTHORIZED');
      return json({ user: { id: 'reader' } });
    },
  });
  await sessionFail.initialize();
  assert.equal(sessionFail.getSnapshot().status, 'guest');
  assert.equal((await sessionFail.credentials()).token, null);
});
