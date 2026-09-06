import { ApiError, readResponse } from './http.js';

// Tokens live only in this closure. Storage carries an account-change marker, never credentials.
export function createSession({ baseUrl, fetcher = fetch, locks, storage, channel, listenStorage = () => () => {}, now = Date.now, makeId = () => crypto.randomUUID() }) {
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
  const clear = (status = 'guest', error = null) => { token = null; expiresAt = 0; emit({ status, user: null, error }); };
  const unsupported = () => new ApiError(0, 'BROWSER_UNSUPPORTED', 'Please use an up-to-date browser to sign in.');
  const exclusive = work => {
    if (!locks?.request || !storage) return Promise.reject(unsupported());
    return locks.request(key, { mode: 'exclusive' }, work);
  };
  const authPost = async (path, body) => readResponse(await fetcher(`${baseUrl}/auth/${path}`, {
    method: 'POST', credentials: 'include',
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
  function refresh(rejectedToken) {
    if (refreshPending) return refreshPending;
    refreshPending = exclusive(async () => {
      sync();
      if (marker?.signedOut) { clear(); return null; }
      if (token && token !== rejectedToken && expiresAt > now() + 5000) return token;
      const startedWith = marker;
      try {
        const result = await authPost('refresh');
        const { user } = await readResponse(await fetcher(`${baseUrl}/auth/me`, {
          credentials: 'include', headers: { Authorization: `Bearer ${result.accessToken}` },
        }));
        if (!sameMarker(startedWith, readMarker())) { sync(); return null; }
        accept(result, user);
        return token;
      } catch (error) {
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
  async function initialize() {
    if (initialized) return refreshPending;
    initialized = true;
    try { marker = storage ? readMarker() : null; await refresh(); }
    catch (error) { if (state.status === 'restoring') clear('error', error); }
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
    return exclusive(async () => {
      // Persist local logout even if the network fails, so another tab cannot silently restore it.
      publish(true);
      clear();
      await authPost('logout');
    });
  }
  async function credentials() {
    await initialize();
    sync();
    if (state.status === 'restoring') await refresh();
    if (token && expiresAt <= now() + 5000) await refresh(token);
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
  if (channel) channel.onmessage = changed;
  const unlisten = listenStorage(event => { if (event.key === key) changed(); });
  return {
    initialize, refresh, authenticate, logout, credentials, invalidate, accountUnchanged,
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
