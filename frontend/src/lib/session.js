import { ApiError, readResponse } from './http.js';

// Tokens live only in this closure. Storage carries an account-change marker, never credentials.
const LOGOUT_CLEANUP_MS = 3000;
const LOGOUT_LOCK_WAIT_MS = 10000;

export function createSession({ baseUrl, fetcher = fetch, locks, storage, channel, listenStorage = () => () => {}, now = Date.now, makeId = () => crypto.randomUUID(), beforeLogout, onSignedOut, logoutCleanupMs = LOGOUT_CLEANUP_MS, logoutLockWaitMs = LOGOUT_LOCK_WAIT_MS }) {
  const key = `bookish:session:${baseUrl}`;
  let token = null;
  let expiresAt = 0;
  let marker = null;
  let refreshPending = null;
  let refreshController = null;
  let initialized = false;
  let state = { status: 'restoring', user: null, error: null, version: 0 };
  const listeners = new Set();
  const emit = (next) => { state = { ...state, ...next, version: state.version + 1 }; listeners.forEach(fn => fn()); };
  const readMarker = () => JSON.parse(storage.getItem(key) ?? 'null');
  const sameMarker = (a, b) => a?.id === b?.id;
  let explicitLogout = false;
  const clear = (status = 'guest', error = null) => {
    // Authenticated invalidate/refresh 401, and a revoked session discovered while restoring.
    // Network and 5xx failures do not come through here, so they do not drop push state.
    const ended = status === 'guest' && !explicitLogout && (state.status === 'authenticated' || state.status === 'restoring');
    token = null; expiresAt = 0; emit({ status, user: null, error });
    if (ended && typeof onSignedOut === 'function') void Promise.resolve(onSignedOut()).then(() => {}, () => {});
  };
  const unsupported = () => new ApiError(0, 'BROWSER_UNSUPPORTED', 'Please use an up-to-date browser to sign in.');
  const exclusive = work => {
    if (!locks?.request || !storage) return Promise.reject(unsupported());
    return locks.request(key, { mode: 'exclusive' }, work);
  };
  const authPost = async (path, body, signal) => readResponse(await fetcher(`${baseUrl}/auth/${path}`, {
    method: 'POST', credentials: 'include', signal,
    headers: { 'Content-Type': 'application/json', 'X-Bookish-CSRF': '1' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  }));
  function accept(result, user) {
    token = result.accessToken;
    // JWT exp is used only to schedule refresh; the server still verifies the token.
    try { expiresAt = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; }
    catch { expiresAt = now() + result.expiresIn * 1000; }
    emit({ status: 'authenticated', user, error: null });
  }
  function publish(signedOut) {
    const next = { id: makeId(), signedOut };
    storage.setItem(key, JSON.stringify(next));
    marker = next;
    channel?.postMessage(next);
  }
  function sync() {
    if (!storage) return;
    const next = readMarker();
    if (!sameMarker(next, marker)) {
      marker = next;
      clear(next?.signedOut ? 'guest' : 'restoring');
    }
  }
  function refresh(rejectedToken, signal) {
    // A caller's abort signal only stops that caller waiting. Aborting the shared
    // request can drop a rotated refresh cookie; the next refresh then looks like reuse.
    // Logout aborts refreshController itself once push cleanup has had its turn.
    if (refreshPending) return observeAbort(refreshPending, signal);
    const controller = new AbortController();
    refreshController = controller;
    const localSignal = controller.signal;
    refreshPending = exclusive(async () => {
      sync();
      if (marker?.signedOut) { clear(); return null; }
      if (token && token !== rejectedToken && expiresAt > now() + 5000) return token;
      const startedWith = marker;
      try {
        const result = await authPost('refresh', undefined, localSignal);
        const { user } = await readResponse(await fetcher(`${baseUrl}/auth/me`, {
          credentials: 'include', signal: localSignal, headers: { Authorization: `Bearer ${result.accessToken}` },
        }));
        if (!sameMarker(startedWith, readMarker())) { sync(); return null; }
        accept(result, user);
        return token;
      } catch (error) {
        if (localSignal.aborted || error?.name === 'AbortError') throw error;
        if (error.status === 401) { clear(); return null; }
        // A network error must not masquerade as logout or trigger an automatic refresh loop.
        emit({ status: token ? 'authenticated' : 'error', error });
        throw error;
      }
    }).catch(error => {
      if (error.code === 'BROWSER_UNSUPPORTED') clear('error', error);
      throw error;
    }).finally(() => {
      refreshPending = null;
      if (refreshController === controller) refreshController = null;
    });
    return observeAbort(refreshPending, signal);
  }
  async function initialize(signal) {
    if (initialized) return refreshPending;
    initialized = true;
    try { marker = storage ? readMarker() : null; await refresh(undefined, signal); }
    catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      if (state.status === 'restoring') clear('error', error);
    }
  }
  async function authenticate(action, body) {
    return exclusive(async () => {
      // Check storage availability before making a cookie-changing request.
      storage.setItem(key, JSON.stringify(readMarker()));
      const startedWith = marker;
      const result = await authPost(action, body);
      // A logout that published while this request was in flight must not be overwritten.
      if (!sameMarker(startedWith, readMarker())) { sync(); return null; }
      publish(false);
      accept(result, result.user);
      return result.user;
    });
  }
  function observeAbort(pending, signal) {
    if (!signal) return pending;
    if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => finish(reject, new DOMException('The operation was aborted.', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  async function logout() {
    // Bound push cleanup so a cold API or a hung PushManager cannot leave the reader signed in.
    explicitLogout = true;
    try {
      if (typeof beforeLogout === 'function') {
        const controller = new AbortController();
        let timer;
        let timedOut = false;
        const timeout = new Promise(resolve => {
          timer = setTimeout(() => { timedOut = true; controller.abort(); resolve(); }, logoutCleanupMs);
        });
        const cleanup = Promise.resolve()
          .then(() => beforeLogout({ signal: controller.signal }))
          .then(() => {}, () => {});
        try { await Promise.race([cleanup, timeout]); }
        finally { clearTimeout(timer); }
        if (timedOut) console.warn('[session] Push cleanup timed out; continuing sign-out');
      }
      // Drop local credentials before waiting for the auth lock. An in-flight refresh
      // compares markers and will not accept a new token after this publish.
      refreshController?.abort();
      publish(true);
      clear();
      const revocation = exclusive(async () => { await authPost('logout'); });
      const finished = revocation.then(() => 'done', () => 'failed');
      let timer;
      const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), logoutLockWaitMs); });
      try {
        const outcome = await Promise.race([finished, timedOut]);
        if (outcome === 'timeout') {
          console.warn('[session] Sign-out is waiting on another request; this device is already signed out');
          return;
        }
        if (outcome === 'failed') await revocation;
      } finally { clearTimeout(timer); }
    } finally { explicitLogout = false; }
  }
  async function credentials(options) {
    const signal = options?.signal;
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    await initialize(signal);
    sync();
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (state.status === 'restoring') await refresh(undefined, signal);
    if (token && expiresAt <= now() + 5000) await refresh(token, signal);
    return { token, marker: marker?.id, userId: state.user?.id };
  }
  function invalidate(rejectedToken) { if (token === rejectedToken) clear(); }
  function accountUnchanged(id) { sync(); return marker?.id === id; }
  function changed() {
    try {
      sync();
      if (state.status === 'restoring') void refresh().catch(() => {});
    } catch (error) { clear('error', error); }
  }
  function updateUser(nextUser) {
    if (!nextUser || state.status !== 'authenticated' || !state.user || state.user.id !== nextUser.id) return;
    emit({ user: nextUser });
  }
  if (channel) channel.onmessage = changed;
  const unlisten = listenStorage(event => { if (event.key === key) changed(); });
  return {
    initialize, refresh, authenticate, logout, credentials, invalidate, accountUnchanged, updateUser,
    isExpired: value => {
      // Another request may already have replaced this token while its response was in flight.
      try { return JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000 <= now(); }
      catch { return value === token && expiresAt <= now(); }
    },
    getSnapshot: () => state,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    destroy: () => { unlisten(); channel?.close(); listeners.clear(); },
  };
}
