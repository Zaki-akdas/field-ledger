/**
 * Entries made without signal wait here. Each one carries the id the salesman's
 * phone generated, so a replay can never double-collect a payment.
 */
const KEY = 'field-ledger:outbox:v1';
const EVENT = 'field-ledger:outbox';

export function uid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent(EVENT, { detail: list.length }));
}

export function list() {
  return read();
}

export function enqueue(op) {
  const list = read();
  if (list.some((o) => o.id === op.id)) return list;
  const next = [...list, { created_at: new Date().toISOString(), attempts: 0, ...op }];
  write(next);
  return next;
}

export function remove(ids) {
  const set = new Set(ids);
  const next = read().filter((o) => !set.has(o.id));
  write(next);
  return next;
}

export function markError(ids, message) {
  const set = new Set(ids);
  const next = read().map((o) => (set.has(o.id) ? { ...o, error: message, attempts: (o.attempts || 0) + 1 } : o));
  write(next);
  return next;
}

export function clear() {
  write([]);
}

export function subscribe(cb) {
  const handler = () => cb(read());
  window.addEventListener(EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}
