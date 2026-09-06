import { ApiError, readResponse } from './http.js';

export function createApi({ baseUrl, session, fetcher = fetch }) {
  return async function request(path, { auth = 'optional', method = 'GET', body, signal } = {}) {
    const context = auth === 'none' ? { token: null } : await session.credentials();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (auth === 'required' && !context.token) throw new ApiError(401, 'AUTH_REQUIRED', 'Please sign in to continue.');
    const send = token => fetcher(baseUrl + path, {
      method, signal, credentials: 'include',
      headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }).then(readResponse);
    const checkAccount = () => {
      if (auth !== 'none' && !session.accountUnchanged(context.marker)) {
        throw new ApiError(409, 'SESSION_CHANGED', 'Your account changed. Please try again.');
      }
    };
    try {
      const result = await send(context.token);
      checkAccount();
      return result;
    } catch (error) {
      checkAccount();
      if (signal?.aborted) throw error;
      if (error.status !== 401 || !context.token) throw error;
      if (error.code !== 'INVALID_TOKEN' || !session.isExpired(context.token)) {
        session.invalidate(context.token);
        throw error;
      }
      const renewed = await session.refresh(context.token);
      checkAccount();
      if (!renewed) throw new ApiError(401, 'AUTH_REQUIRED', 'Please sign in again.');
      // Exactly one replay; no recursion and no replay after a changed account.
      try {
        const result = await send(renewed);
        checkAccount();
        return result;
      } catch (retryError) {
        if (retryError.status === 401) session.invalidate(renewed);
        throw retryError;
      }
    }
  };
}
