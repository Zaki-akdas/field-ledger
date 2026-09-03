/**
 * Client-side Realtime hook using Server-Sent Events.
 * Subscribes to live changes on collections, bills, cancellations, short_items.
 *
 * Usage:
 *   const { connected, lastEvent } = useRealtime();
 *   // or subscribe to specific tables:
 *   useRealtime('collections', (event) => { ... });
 */
import { useEffect, useCallback, useRef, useState } from 'react';
import { getToken } from './api.js';

const ALL_TABLES = ['collections', 'bills', 'cancellations', 'short_items'];
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT = 30000;

/**
 * Subscribe to all realtime events or a specific table.
 * @param {string|null} table - Table name to filter, or null for all
 * @param {Function|null} onEvent - Callback when event arrives
 */
export function useRealtime(table = null, onEvent = null) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);
  // Bumped on every failed attempt so the effect re-runs (state-driven reconnect
  // with exponential backoff, rather than a self-recursive callback).
  const [attempt, setAttempt] = useState(0);
  const delayRef = useRef(RECONNECT_DELAY);
  const onEventRef = useRef(onEvent);

  // Keep callback ref fresh
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

  useEffect(() => {
    const token = getToken();
    // Guard for environments without SSE support (jsdom tests, old webviews).
    if (!token || typeof EventSource === 'undefined') {
      setConnected(false);
      return undefined;
    }

    const tables = table ? [table] : ALL_TABLES;
    const es = new EventSource(`/api/realtime?token=${encodeURIComponent(token)}`);
    let closed = false;

    es.onopen = () => {
      if (closed) return;
      setConnected(true);
      delayRef.current = RECONNECT_DELAY; // Reset backoff on success
    };

    for (const t of tables) {
      es.addEventListener(t, (e) => {
        if (closed) return;
        try {
          const data = JSON.parse(e.data);
          setLastEvent({ table: t, ...data, timestamp: Date.now() });
          if (onEventRef.current) onEventRef.current({ table: t, ...data });
        } catch { /* ignore parse errors */ }
      });
    }

    es.onerror = () => {
      if (closed) return;
      es.close();
      setConnected(false);
      const delay = delayRef.current;
      delayRef.current = Math.min(delayRef.current * 2, MAX_RECONNECT);
      setTimeout(() => { if (!closed) setAttempt((a) => a + 1); }, delay);
    };

    return () => {
      closed = true;
      es.close();
    };
  }, [table, attempt]);

  return { connected, lastEvent };
}

/**
 * Hook that returns a counter of events per table — useful for showing
 * "3 new collections" badges.
 */
export function useRealtimeCount() {
  const [counts, setCounts] = useState({});

  const handleEvent = useCallback((event) => {
    setCounts((prev) => ({
      ...prev,
      [event.table]: (prev[event.table] || 0) + 1,
    }));
  }, []);

  const { connected } = useRealtime(null, handleEvent);

  const reset = useCallback((table) => {
    setCounts((prev) => ({ ...prev, [table]: 0 }));
  }, []);

  return { connected, counts, reset };
}
