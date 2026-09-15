/*
 * Field Ledger service worker.
 *
 * The outbox already protects writes made offline; this file protects the app
 * itself: the shell loads and the field screens read their last-known data
 * with no signal at all.
 *
 * Resource classes:
 *   - precache (shell + icons)          — cache-first, refreshed on update
 *   - hashed build assets /assets/*     — cache-first (immutable)
 *   - field read API (bills, dashboards)— stale-while-revalidate
 *   - navigations                       — network-first, cached index.html fallback
 *   - everything else (auth, uploads,   — pass through untouched
 *     exports, non-GET writes)
 *
 * Updates: a new build changes the precache list, so the waiting worker
 * takes over on next load (skipWaiting) and the page is told via message
 * 'sw:updated' — the app shows a "reload to update" toast.
 */
const VERSION = 'v1';
const SHELL_CACHE = `fl-shell-${VERSION}`;
const ASSET_CACHE = `fl-assets-${VERSION}`;
const API_CACHE = `fl-api-${VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/site.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

const FIELD_READ_API = [
  /^\/api\/bills(\?|$)/,
  /^\/api\/bills\/\d+$/,
  /^\/api\/me\/dashboard\?/,
  /^\/api\/session\/today/,
  /^\/api\/products/,
  /^\/api\/shops\/\d+\/payment-pattern/,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('fl-') && n !== SHELL_CACHE && n !== ASSET_CACHE && n !== API_CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
    const all = await self.clients.matchAll({ type: 'window' });
    for (const client of all) client.postMessage({ type: 'sw:updated', version: VERSION });
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
  if (event.data?.type === 'outbox-changed') {
    // Entries were queued while the app was open; register the sync tag so
    // the flush also happens later if the app closes before signal returns.
    event.waitUntil(registerOutboxSync());
  }
});

/* ------------------------------------------------------ background sync --- */

/*
 * The outbox queue and the auth token live in IndexedDB (mirrored from the
 * app by client/src/lib/mirror.js — localStorage is invisible here). When the
 * browser later decides connectivity is back, it fires the 'sync' event even
 * if every app window is closed; the flush below replays the queue through
 * POST /api/sync exactly as the app itself would, then shows a notification
 * with the outcome.
 */
const SYNC_TAG = 'field-ledger-outbox-sync';

async function registerOutboxSync() {
  try {
    // Registration itself throws if the queue is empty or permission denied.
    await self.registration.sync.register(SYNC_TAG);
  } catch {
    // Browser without Background Sync (Safari, Firefox): no signal means the
    // queue just waits for the next app open, as before.
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(flushOutbox());
});

/*
 * IndexedDB mirror access (same store the app writes via lib/mirror.js —
 * inlined here because a service worker cannot import from the bundled src
 * tree). Store shape: one object store 'kv' keyed by string.
 */
const MIRROR_DB = 'field-ledger-sync';
const MIRROR_STORE = 'kv';

function mirrorOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MIRROR_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(MIRROR_STORE)) req.result.createObjectStore(MIRROR_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function mirrorGet(key) {
  const db = await mirrorOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MIRROR_STORE, 'readonly');
    const req = tx.objectStore(MIRROR_STORE).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function mirrorPut(key, value) {
  const db = await mirrorOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MIRROR_STORE, 'readwrite');
    tx.objectStore(MIRROR_STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function flushOutbox() {
  const queue = (await mirrorGet('outbox')) || [];
  if (queue.length === 0) return;
  const token = await mirrorGet('token');
  if (!token) return; // signed out: leave the queue for a future session

  let results;
  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ops: queue.map(({ payload, type, id }) => ({ id, type, payload })) }),
    });
    if (!res.ok) throw new Error(`sync ${res.status}`);
    ({ results } = await res.json());
  } catch {
    // Still offline or the server refused: throw so the browser retries the
    // sync event with backoff; nothing is removed from the queue.
    throw new Error('sync unreachable');
  }

  // Persist the outcome for the app's next open, then prune the mirror so a
  // later flush cannot replay entries the server already accepted.
  const okIds = results.filter((r) => r.ok).map((r) => r.id);
  const failed = results.filter((r) => !r.ok);
  const remaining = queue.filter((o) => !okIds.includes(o.id)).map((o) => {
    const f = failed.find((x) => x.id === o.id);
    return f ? { ...o, error: f.error, attempts: (o.attempts || 0) + 1 } : o;
  });
  await mirrorPut('outbox', remaining);
  await mirrorPut('results', { results, at: Date.now() });

  await notifyOutcome(okIds.length, failed);
}

async function notifyOutcome(synced, failed) {
  if (synced === 0 && failed.length === 0) return;
  const title = synced && failed.length === 0
    ? `${synced} ${synced === 1 ? 'entry' : 'entries'} synced`
    : failed.length
      ? `${failed.length} ${failed.length === 1 ? 'entry needs' : 'entries need'} attention`
      : 'Sync complete';
  const body = failed.length
    ? failed[0].error
    : 'All entries made without signal reached the office.';

  await self.registration.showNotification(title, {
    body,
    tag: 'field-ledger-sync', // collapse repeated syncs into one notification
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: '/field/me' },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/field/me';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => new URL(c.url).pathname.startsWith('/field'));
    if (client) return client.focus();
    return self.clients.openWindow(url);
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // writes: outbox territory, never cached

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept auth, realtime SSE, exports, or attachment streams.
  if (/^\/api\/(auth|realtime|export)/.test(url.pathname) || url.pathname.startsWith('/uploads/')) return;

  // Hashed build assets: immutable, cache-first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
    return;
  }

  // Field read API: stale-while-revalidate — instant offline, fresh online.
  if (FIELD_READ_API.some((re) => re.test(url.pathname + url.search))) {
    event.respondWith(staleWhileRevalidate(event, req, API_CACHE));
    return;
  }

  // Navigations (SPA routes): network-first so a new deploy arrives promptly,
  // cached shell when there is no signal.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(req));
  }
});

/* ------------------------------------------------------------ strategies --- */

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(event, req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  // Refresh in the background; waitUntil keeps the worker alive for the put
  // (a fire-and-forget put can be killed the moment respondWith settles).
  event.waitUntil((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) await cache.put(req, res.clone());
    } catch { /* offline: cached copy is the answer */ }
  })());
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    return offlineJson();
  }
}

async function networkFirstNavigation(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    // A 5xx is as useless as no signal in the field — fall back to the shell
    // so the app still opens and the outbox keeps working.
    if (!res.ok) throw new Error(`navigation ${res.status}`);
    cache.put('/index.html', res.clone()).catch(() => {});
    return res;
  } catch {
    const shell = (await cache.match('/index.html')) || (await cache.match('/'));
    return shell || Response.error();
  }
}

function offlineJson() {
  return new Response(JSON.stringify({ offline: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
