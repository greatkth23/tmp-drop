import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthStatus } from '../../shared/contracts';
import { authStatus, message } from '../api';
export function useAuthStatus() {
  const [auth, setAuth] = useState<AuthStatus | null>(null),
    [error, setError] = useState(''),
    [offset, setOffset] = useState(0);
  const request = useRef<Promise<AuthStatus | null> | null>(null);
  const refresh = useCallback(async (fresh = true) => {
    // A request started before an auth mutation can describe old cookies/CSRF.
    if (request.current) {
      if (!fresh) return request.current;
      await request.current;
      if (request.current) return request.current;
    }
    request.current = authStatus()
      .then((result) => {
        setAuth(result);
        setOffset(result.serverNow - Date.now());
        setError('');
        return result;
      })
      .catch((e) => {
        setError(message(e));
        return null;
      })
      .finally(() => {
        request.current = null;
      });
    return request.current;
  }, []);
  useEffect(() => {
    void refresh(false);
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh(false);
    };
    const timer = setInterval(visible, 30_000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  return { auth, error, offset, refresh };
}
export function useNow(offset = 0, interval = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now + offset;
}
