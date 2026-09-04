/**
 * Origin-aware back navigation for the field app.
 *
 * Pages deep in a bill or report remember where the salesman tapped from by
 * carrying a ?back=<tab path> query param, so their back control returns to
 * that tab instead of a hardcoded one. Only the fixed list below is honored —
 * a hand-edited ?back= can't forge where the back button goes.
 */
const VALID_BACK = new Set(['/field/bills', '/field/collect', '/field/me', '/field/start']);

/** Decode a ?back= origin from a location search string; null when absent or not a known tab. */
export function readBack(search) {
  const raw = new URLSearchParams(search).get('back');
  return raw && VALID_BACK.has(raw) ? raw : null;
}

/** Append ?back=<tab> to a path when tab is a known tab path; otherwise return path unchanged. */
export function withBack(path, tab) {
  return tab && VALID_BACK.has(tab) ? `${path}?back=${encodeURIComponent(tab)}` : path;
}
