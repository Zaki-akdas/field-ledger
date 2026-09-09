import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { uid } from './outbox.js';

const THEME_KEY = 'field-ledger:theme';

/**
 * Dark mode hook — prefers localStorage, falls back to system preference.
 * Applies the `dark` class to <html> for Tailwind's `darkMode: 'class'`.
 */
export function useDarkMode() {
  const [dark, setDark] = useState(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'dark') return true;
      if (stored === 'light') return false;
    } catch { /* ignore */ }
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* ignore */ }
  }, [dark]);

  // Listen for system preference changes when no manual override is stored.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e) => {
      try {
        if (!localStorage.getItem(THEME_KEY)) {
          setDark(e.matches);
        }
      } catch { /* ignore */ }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const toggle = useCallback(() => setDark((d) => !d), []);

  return { dark, toggle };
}

const REFRESH_EVENT = 'field-ledger:refresh-all';

/** Ask every mounted useApi to refetch at once — wired to the RefreshButton.
 * Safer than window.location.reload(): keeps SPA state, no full boot. */
export function broadcastRefresh() {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

export function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify(deps);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // A manual refresh anywhere bumps this hook's nonce so the data on screen
  // refetches without a full page reload.
  useEffect(() => {
    const onRefresh = () => setNonce((n) => n + 1);
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_EVENT, onRefresh);
  }, []);

  useEffect(() => {
    if (!path) { setState({ data: null, loading: false, error: null }); return; }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    api.get(path, { signal: ctrl.signal })
      .then((data) => { if (!ctrl.signal.aborted) setState({ data, loading: false, error: null }); })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        // AbortError means the component unmounted or path changed — don't
        // update state at all, the new effect is already in flight.
        if (err?.name === 'AbortError') return;
        setState({ data: null, loading: false, error: err });
      });
    return () => ctrl.abort();
  }, [path, nonce, key]);

  return { ...state, reload };
}

/** Fires when the user presses Escape — used by sheets and dialogs. */
export function useEscape(handler, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const fn = (e) => { if (e.key === 'Escape') handler(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [handler, active]);
}

export function useBodyScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [active]);
}

export function newId() {
  return uid();
}

/** Compresses a photo to something the offline queue can carry. */
export function fileToCompressedDataUrl(file, maxSide = 1200, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that photo.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That image could not be opened.'));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function downloadTemplate() {
  const csv = [
    'Invoice No,Customer,Area,Amount,Date',
    'INV/2026/9001,Sharma General Store,Vijay Nagar,18400,2026-09-02',
    'INV/2026/9002,Gupta Kirana,Palasia,7250,2026-09-02',
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bill-upload-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function useTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · Field Ledger` : 'Field Ledger';
  }, [title]);
}
