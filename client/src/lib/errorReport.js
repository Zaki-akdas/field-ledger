/**
 * Client error reporter. Ships crashes to POST /api/errors — fire-and-forget,
 * rate-limited server-side, and silent on failure (a reporter that throws
 * inside an error path makes things worse).
 *
 * Sent from:
 *   - ErrorBoundary (render crashes, with component stack)
 *   - window.onerror / unhandledrejection (installed in main.jsx)
 *   - api.js (unexpected 5xx responses)
 *
 * Dedupe: identical messages inside one page session are sent once, so a
 * crash loop in a render effect can't spam the endpoint past its rate limit.
 */

const sent = new Set();
let sessionFingerprint = null;

function fingerprint() {
  if (sessionFingerprint === null) {
    // Per-page-load id so the server can group reports from one session.
    sessionFingerprint = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  return sessionFingerprint;
}

export function reportError(err, { kind = 'error', componentStack = null, context = null } = {}) {
  try {
    const message = err?.message || String(err || 'Unknown error');
    const stack = err?.stack || null;

    // Same message + kind twice in one session: send once.
    const key = kind + '::' + message;
    if (sent.has(key)) return;
    sent.add(key);
    // Bound the set so a long session with many distinct errors can't grow it forever.
    if (sent.size > 100) sent.delete(sent.values().next().value);

    const payload = {
      kind,
      message: message.slice(0, 2000),
      stack: stack ? String(stack).slice(0, 8000) : null,
      componentStack: componentStack ? String(componentStack).slice(0, 8000) : null,
      url: window.location.href,
      context: { ...context, fp: fingerprint(), ts: Date.now() },
    };

    // KeepAlive-free plain fetch: no credentials needed (server identifies the
    // user from the Bearer token when present), no retry — the sink is
    // best-effort by design.
    fetch('/api/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    /* never let the reporter be the crash */
  }
}
