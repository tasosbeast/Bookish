import { ApiError, readResponse } from './http.js';

// Tokens live only in this closure. Storage carries an account-change marker, never credentials.
const LOGOUT_CLEANUP_MS = 3000;

export function createSession({ baseUrl, fetcher = fetch, locks, storage, channel, listenStorage = () => () => {}, now = Date.now, makeId = () => crypto.randomUUID(), beforeLogout, onSignedOut, logoutCleanupMs = LOGOUT_CLEANUP_MS }) {
  const key = `bookish:session:${baseUrl}`;
  let token = null;
  let expiresAt = 0;
  let marker = null;
  let refreshPending = null;
  let initialized = false;
  let state = { status: 'restoring', user: null, error: null, version: 0 };
  const listeners = new Set();
  const emit = (next) => { state = { ...state, ...next, version: state.version + 1 }; listeners.forEach(fn => fn()); };
  const readMarker = () => JSON.parse(storage.getItem(key) ?? 'null');
  const sameMarker = (a, b) => a?.id === b?.id;
  let explicitLogout = false;
  const clear = (status = 'guest', error = null) => {
    const forcedSignOut = state.status === 'authenticated' && status === 'guest' && !explicitLogout;
    token = null; expiresAt = 0; emit({ status, user: null, error });
    // Refresh 401 and invalidate() land here with no access token left, so only the browser subscription can be dropped.
    if (forcedSignOut && typeof onSignedOut === 'function') void Promise.resolve(onSignedOut()).then(() => {}, () => {});
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
    if (refreshPending) return refreshPending;
    refreshPending = exclusive(async () => {
      sync();
      if (marker?.signedOut) { clear(); return null; }
      if (token && token !== rejectedToken && expiresAt > now() + 5000) return token;
      const startedWith = marker;
      try {
        const result = await authPost('refresh', undefined, signal);
        const { user } = await readResponse(await fetcher(`${baseUrl}/auth/me`, {
          credentials: 'include', signal, headers: { Authorization: `Bearer ${result.accessToken}` },
        }));
        if (!sameMarker(startedWith, readMarker())) { sync(); return null; }
        accept(result, user);
        return token;
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        if (error.status === 401) { clear(); return null; }
        // A network error must not masquerade as logout or trigger an automatic refresh loop.
        emit({ status: token ? 'authenticated' : 'error', error });
        throw error;
      }
    }).catch(error => {
      if (error.code === 'BROWSER_UNSUPPORTED') clear('error', error);
      throw error;
    }).finally(() => { refreshPending = null; });
    return refreshPending;
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
      const result = await authPost(action, body);
      publish(false);
      accept(result, result.user);
      return result.user;
    });
  }
  async function logout() {
    // Bound push cleanup so a cold API or a hung PushManager cannot leave the reader signed in.
    // The signal aborts the delete and any refresh it started, which releases the auth lock.
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
      return await exclusive(async () => {
        // Persist local logout even if the network fails, so another tab cannot silently restore it.
        publish(true);
        clear();
        await authPost('logout');
      });
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
