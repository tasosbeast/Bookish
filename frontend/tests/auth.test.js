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
