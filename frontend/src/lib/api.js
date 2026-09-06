import { createSession } from './session.js';
import { createApi } from './client.js';

const baseUrl = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api').replace(/\/+$/, '');
let storage;
try { storage = window.localStorage; } catch { /* Auth fails closed when coordination is unavailable. */ }
export const session = createSession({ baseUrl, locks: navigator.locks, storage,
  channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`bookish-auth:${baseUrl}`) : null,
  listenStorage: fn => { window.addEventListener('storage', fn); return () => window.removeEventListener('storage', fn); },
});
export const api = createApi({ baseUrl, session });
