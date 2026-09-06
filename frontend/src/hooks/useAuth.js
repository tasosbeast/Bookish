import { useSyncExternalStore } from 'react';
import { session } from '../lib/api.js';
export function useAuth() { return useSyncExternalStore(session.subscribe, session.getSnapshot); }
