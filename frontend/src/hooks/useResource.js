import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from './useAuth.js';

export function useResource(path, auth = 'optional', retainScope) {
  const session = useAuth();
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState({});
  const enabled = path && session.status !== 'restoring';
  const key = `${enabled ? path : ''}|${session.user?.id ?? ''}|${version}`;
  // Retention is opt-in and never crosses book/account boundaries.
  const scope = enabled ? JSON.stringify([retainScope ?? path, session.user?.id ?? '', auth]) : null;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let current = true;
    api(path, { auth, signal: controller.signal }).then(data => {
      if (current) setResult({ key, scope, data });
    }).catch(error => {
      if (current && error.name !== 'AbortError') setResult(previous => ({ key, scope, error,
        ...(retainScope !== undefined && previous.scope === scope && { data: previous.data }),
      }));
    });
    return () => { current = false; controller.abort(); };
  }, [key, scope, enabled, path, auth, retainScope]);
  const reload = useCallback(() => setVersion(value => value + 1), []);
  const retained = retainScope !== undefined && scope !== null && result.scope === scope;
  return { ...(retained ? { data: result.data } : {}), ...(result.key === key ? result : {}),
    loading: !enabled || result.key !== key, reload };
}
