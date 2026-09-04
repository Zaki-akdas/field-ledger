/**
 * Origin-aware back navigation for the back office.
 *
 * Admin drill-downs (a salesman's bills, collections and cancellations)
 * remember where the admin tapped from by carrying the origin page in
 * react-router location state (state.back), so the back control returns
 * to that page — the Salesmen list or Reconciliation — instead of always
 * dumping you on the Salesmen list. Only the fixed list below is honored,
 * so a hand-forged value can't point the back button anywhere else. A
 * legacy ?back= query param is still read as a fallback, mirroring the
 * field app's helper.
 */
const VALID_ADMIN_BACK = new Set(['/admin/salesmen', '/admin']);

/** Return value when it names a known admin page; otherwise null. */
export function validAdminBack(value) {
  return value && VALID_ADMIN_BACK.has(value) ? value : null;
}

/** Origin from a react-router location: state.back first, legacy ?back= as fallback. */
export function adminOriginOf(location) {
  if (!location) return null;
  const fromState = validAdminBack(location.state?.back);
  if (fromState) return fromState;
  const raw = new URLSearchParams(location.search).get('back');
  return validAdminBack(raw);
}

/** Human label for a known origin, used by the detail's back control. */
export function adminBackLabel(origin) {
  if (origin === '/admin/salesmen') return 'All salesmen';
  if (origin === '/admin') return 'Reconciliation';
  return null;
}

/**
 * The react-router state object carrying the origin (pass to the `state`
 * option of navigate, or the `state` prop of Link/NavLink). Returns
 * undefined for an unknown origin so callers can pass it straight through —
 * react-router ignores undefined state.
 */
export function adminOriginState(page) {
  const origin = validAdminBack(page);
  return origin ? { back: origin } : undefined;
}