/**
 * Origin-aware back navigation for the field app.
 *
 * Deep pages remember where the salesman tapped from by carrying the origin
 * tab in react-router location state (state.back), so their back control
 * returns to that tab without cluttering the URL with ?back= query params.
 * Only the fixed list below is honored — a hand-forged value can't point the
 * back button anywhere else. A legacy ?back= query param is still read as a
 * fallback, so links made by older builds or saved bookmarks keep working.
 */
const VALID_BACK = new Set(['/field/bills', '/field/collect', '/field/me', '/field/start']);

/** Return value when it names a known tab; otherwise null. */
export function validBack(value) {
  return value && VALID_BACK.has(value) ? value : null;
}

/** Origin from a react-router location: state.back first, legacy ?back= as fallback. */
export function originOf(location) {
  if (!location) return null;
  const fromState = validBack(location.state?.back);
  if (fromState) return fromState;
  const raw = new URLSearchParams(location.search).get('back');
  return validBack(raw);
}

/**
 * The react-router state object carrying the origin (pass to the `state` prop
 * of Link/NavLink, or as `navigate(path, { state })`). Returns undefined for
 * an unknown origin so callers can pass it straight through — react-router
 * ignores undefined state.
 */
export function originState(tab) {
  const origin = validBack(tab);
  return origin ? { back: origin } : undefined;
}
