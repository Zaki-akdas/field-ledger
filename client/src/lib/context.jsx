import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, getToken, setToken, ApiError, ping } from './api.js';
import * as outbox from './outbox.js';

const AuthContext = createContext(null);
const ToastContext = createContext(null);
const SyncContext = createContext(null);

export function useAuth() { return useContext(AuthContext); }
export function useToast() { return useContext(ToastContext); }
export function useSync() { return useContext(SyncContext); }

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    if (!getToken()) { setLoading(false); return; }
    api.get('/auth/me')
      .then((d) => { if (alive) setUser(d.user); })
      .catch(() => setToken(null))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const login = useCallback(async (code, password) => {
    const data = await api.post('/auth/login', { code, password });
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout', {}); } catch { /* ignore */ }
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener('field-ledger:unauthorized', onUnauthorized);
    return () => window.removeEventListener('field-ledger:unauthorized', onUnauthorized);
  }, []);

  const value = useMemo(() => ({ user, loading, login, logout, setUser }), [user, loading, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, tone = 'default') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4200);
  }, []);

  const dismiss = (id) => setToasts((t) => t.filter((x) => x.id !== id));

  return (
    <ToastContext.Provider value={{ push, dismiss }}>
      {children}
      <div className="fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 pointer-events-none safe-bottom">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto max-w-[92vw] rounded-lg px-4 py-3 text-sm shadow-raise border ${
              t.tone === 'error' ? 'bg-attention-tint border-attention/40 text-attention-deep'
                : t.tone === 'success' ? 'bg-settled-tint border-settled/40 text-settled-deep'
                  : 'bg-ink text-paper border-ink'
            }`}
          >
            <div className="flex items-start gap-3">
              <span>{t.message}</span>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="opacity-60 hover:opacity-100 text-xs font-medium shrink-0"
                aria-label="Dismiss"
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const PATHS = {
  bill: '/bills',
  collection: '/collections',
  cancellation: '/cancellations',
  'short-items': '/short-items',
};

export function SyncProvider({ children }) {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [queue, setQueue] = useState(() => outbox.list());
  const [flushing, setFlushing] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const toast = useRef(null);
  const { push } = useContext(ToastContext) || {};

  useEffect(() => { toast.current = push; }, [push]);

  useEffect(() => {
    const syncQueue = () => setQueue(outbox.list());
    return outbox.subscribe(syncQueue);
  }, []);

  const flush = useCallback(async () => {
    const pending = outbox.list();
    if (pending.length === 0 || flushing) return { synced: 0, failed: 0 };
    setFlushing(true);
    try {
      const data = await api.post('/sync', { ops: pending });
      const ok = data.results.filter((r) => r.ok).map((r) => r.id);
      const failed = data.results.filter((r) => !r.ok);
      outbox.remove(ok);
      if (failed.length) {
        for (const f of failed) outbox.markError([f.id], f.error);
      }
      setQueue(outbox.list());
      const result = { synced: ok.length, failed: failed.length, errors: failed.map((f) => `${f.error}`) };
      setLastResult(result);
      if (ok.length && toast.current) {
        toast.current(`${ok.length} ${ok.length === 1 ? 'entry' : 'entries'} synced.`, 'success');
      }
      if (failed.length && toast.current) {
        toast.current(`${failed.length} ${failed.length === 1 ? 'entry needs' : 'entries need'} attention — ${failed[0].error}`, 'error');
      }
      return result;
    } catch (err) {
      return { synced: 0, failed: pending.length, errors: [err.message] };
    } finally {
      setFlushing(false);
    }
  }, [flushing]);

  useEffect(() => {
    const goOnline = () => { setOnline(true); setTimeout(flush, 400); };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [flush]);

  // Some networks report "online" while the request still fails; probe politely.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const ok = await ping();
      if (!alive) return;
      if (ok && !online) { setOnline(true); flush(); }
      else if (!ok && online) setOnline(false);
    };
    const id = setInterval(tick, 20000);
    return () => { alive = false; clearInterval(id); };
  }, [online, flush]);

  useEffect(() => { if (queue.length && online) flush(); }, [queue.length, online, flush]);

  const save = useCallback(async ({ type, payload, label }) => {
    try {
      const data = await api.post(PATHS[type], payload);
      return { data, queued: false };
    } catch (err) {
      if (err instanceof ApiError && err.offline) {
        outbox.enqueue({ id: payload.client_id, type, payload: { ...payload, client_id: undefined }, label });
        return { queued: true, data: null };
      }
      throw err;
    }
  }, []);

  const value = useMemo(() => ({
    online, queue, flushing, flush, save, lastResult,
  }), [online, queue, flushing, flush, save, lastResult]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
