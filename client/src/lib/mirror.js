/**
 * IndexedDB mirror of the data background sync needs while the app is closed:
 * the outbox queue and the auth token. localStorage is the source of truth in
 * the app (single-writer, synchronous, already wired everywhere) — this store
 * is a read-only copy from the service worker's point of view, refreshed on
 * every outbox mutation and token change.
 *
 * Both worlds also share a small "results" mailbox: the SW writes the outcome
 * of a background flush here so the app can reconcile its queue on next open.
 */
const DB_NAME = 'field-ledger-sync';
const DB_VERSION = 1;
const STORE = 'kv';

const OUTBOX_KEY = 'outbox';
const TOKEN_KEY = 'token';
const RESULTS_KEY = 'results';

function openDb() {
  return new Promise((resolve, reject) => {
    // jsdom (smoke tests) and very old webviews have no IndexedDB. Resolve a
    // null handle so callers degrade gracefully instead of crashing.
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(key, value) {
  const db = await openDb();
  if (!db) return; // no IndexedDB: mirror is a no-op
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function get(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/* ----------------------------------------------------------- app side --- */

/** Copy the whole outbox list into the mirror. Called on every mutation. */
export async function mirrorOutbox(list) {
  try { await put(OUTBOX_KEY, list); } catch { /* best effort */ }
}

/** Copy the auth token into the mirror. Null clears it (logout). */
export async function mirrorToken(token) {
  try {
    if (token) await put(TOKEN_KEY, token);
    else await put(TOKEN_KEY, null);
  } catch { /* best effort */ }
}

/* ------------------------------------------------ service-worker side --- */

export async function readOutbox() {
  return (await get(OUTBOX_KEY)) || [];
}

export async function readToken() {
  return (await get(TOKEN_KEY)) || null;
}

/** SW writes the flush outcome; the app drains it on next open. */
export async function writeResults(results) {
  try { await put(RESULTS_KEY, { results, at: Date.now() }); } catch { /* best effort */ }
}

export async function readResults() {
  const r = await get(RESULTS_KEY);
  return r || null;
}

export async function clearResults() {
  try { await put(RESULTS_KEY, null); } catch { /* best effort */ }
}
