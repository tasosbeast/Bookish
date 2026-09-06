import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from './useAuth.js';

export function useResource(path, auth = 'optional') {
  const session = useAuth();
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState({});
  const enabled = path && session.status !== 'restoring';
  const key = `${enabled ? path : ''}|${session.user?.id ?? ''}|${version}`;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let current = true;
    api(path, { auth, signal: controller.signal }).then(data => {
      if (current) setResult({ key, data });
    }).catch(error => {
      if (current && error.name !== 'AbortError') setResult({ key, error });
    });
    return () => { current = false; controller.abort(); };
  }, [key, enabled, path, auth]);
  const reload = useCallback(() => setVersion(value => value + 1), []);
  return { ...(result.key === key ? result : {}), loading: !enabled || result.key !== key, reload };
}
