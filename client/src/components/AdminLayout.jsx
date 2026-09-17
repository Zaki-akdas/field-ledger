import { Link, NavLink, Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { createContext, useContext, useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../lib/context.jsx';
import { downloadExport, downloadBackup, api } from '../lib/api.js';
import { shiftISO, todayISO } from '../lib/format.js';
import { useToast } from '../lib/context.jsx';
import { useDarkMode } from '../lib/hooks.js';
import { useRealtime } from '../lib/realtime.js';
import { useApi } from '../lib/hooks.js';
import { Btn, cx, Field, Input, IconBtn, Select, Sheet, Spinner, Money, RefreshButton } from './ui.jsx';

const RangeContext = createContext(null);
export const useRange = () => useContext(RangeContext);

const NAV = [
  { to: '/admin', label: 'Reconciliation', end: true, badge: null },
  { to: '/admin/collection', label: 'Collection report' },
  { to: '/admin/salesmen', label: 'Salesmen' },
  { to: '/admin/shops', label: 'Shops' },
  { to: '/admin/bills', label: 'Bills' },
  { to: '/admin/cancellations', label: 'Cancellations' },
  { to: '/admin/shortages', label: 'Shortages' },
  { to: '/admin/cash', label: 'Cash rollup' },
  { to: '/admin/bank', label: 'Bank' },
  { to: '/admin/upload', label: 'Upload bills' },
  { to: '/admin/trash', label: 'Trash' },
  { to: '/admin/audit', label: 'Audit log' },
  { to: '/admin/errors', label: 'Errors' },
  { to: '/admin/system', label: 'System' },
];

// Unread-error badge: remembers how far the admin has reviewed the error log
// (the newest report id at the time the Errors page was open) so the sidebar
// item can light up when new crashes land afterwards. Best-effort — a failed
// poll just means no badge, never a broken page.
const ERRORS_SEEN_KEY = 'field-ledger:errors:last-seen';

function useUnreadErrors(onErrorsPage) {
  const [unread, setUnread] = useState(0);

  // Opening the Errors page IS the review — clear instantly, and record the
  // newest id on the next successful poll below.
  useEffect(() => {
    if (onErrorsPage) setUnread(0);
  }, [onErrorsPage]);

  useEffect(() => {
    let alive = true;
    let timer;
    const check = async () => {
      try {
        const seen = Number(localStorage.getItem(ERRORS_SEEN_KEY) || '-1');
        const d = await api.get(`/admin/errors/unread${seen >= 0 ? `?after=${seen}` : ''}`);
        if (!alive) return;
        if (onErrorsPage) {
          localStorage.setItem(ERRORS_SEEN_KEY, String(d.latestId));
          setUnread(0);
        } else {
          setUnread(d.count);
        }
      } catch { /* badge is best-effort */ }
      if (alive) timer = setTimeout(check, 30000);
    };
    check();
    return () => { alive = false; clearTimeout(timer); };
  }, [onErrorsPage]);

  return unread;
}

function UnreadBadge({ count }) {
  return (
    <span
      className="num shrink-0 rounded-full bg-attention px-1.5 py-0.5 text-[10.5px] font-semibold leading-none text-paper"
      aria-label={`${count} new error reports`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

// System-health indicator (desktop sidebar footer + mobile header strip):
// polls GET /api/status — the same endpoint uptime checkers watch — and shows
// one dot each for database, storage, and backup freshness. A 503 (database
// or storage down) is a normal response here, carrying the full payload in
// err.body, so the down state is read from that — never reported to the
// error sink. Best-effort: a failed/absent status just hides the indicator.
const HEALTH_POLL_MS = 60_000;

function useSystemHealth() {
  const [health, setHealth] = useState(null);
  // True only while a focus/online/visibility-triggered refresh is in flight
  // (never during the mount poll or the routine 60s tick) — the health card
  // shows a subtle spinner so a refocusing admin can tell fresh from cached.
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer;
    let lastStarted = 0; // debounce: tab-switch flurries fire one refresh
    const poll = async () => {
      lastStarted = Date.now();
      try {
        const body = await api.get('/status');
        if (alive) setHealth(body);
      } catch (err) {
        if (alive && err?.body?.checks) setHealth(err.body); // 503 = status itself is fine
      }
      if (alive) { setRefreshing(false); timer = setTimeout(poll, HEALTH_POLL_MS); }
    };
    // Returning to the tab (or the network coming back) should show the
    // current state instantly, not up to a minute of staleness — but only
    // if the last poll isn't brand new anyway (min 10s between refreshes).
    const refreshSoon = () => {
      if (!alive) return;
      const since = Date.now() - lastStarted;
      if (since < 10_000) return;
      clearTimeout(timer);
      setRefreshing(true);
      timer = setTimeout(poll, 150); // let focus paint first; then refresh
    };
    const onVisible = () => { if (document.visibilityState === 'visible') refreshSoon(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refreshSoon);
    window.addEventListener('online', refreshSoon);
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refreshSoon);
      window.removeEventListener('online', refreshSoon);
    };
  }, []);

  return { health, refreshing };
}

function HealthDot({ ok, label, detail }) {
  return (
    <span
      className={cx('h-2 w-2 shrink-0 rounded-full', ok ? 'bg-settled' : 'bg-attention')}
      title={`${label}: ${detail || (ok ? 'ok' : 'problem')}`}
      aria-label={`${label}: ${ok ? 'healthy' : 'problem'}`}
      role="img"
    />
  );
}

function SystemHealth({ health, refreshing, compact = false }) {
  if (!health?.checks) return null;
  const { database, storage, backup } = health.checks;
  const problems = [database, storage].filter((c) => c && !c.ok).length + (backup?.stale ? 1 : 0);

  // Compact (mobile header strip): dots + summary only. The full DB/Storage/
  // Backup detail block has a natural min-width the 320px header can't give
  // it — it pushed every admin page +13px past the viewport. The detail
  // lives one tap away on /admin/system (the summary line links there).
  if (compact) {
    return (
      <div
        className="min-w-0 rounded-lg border border-line bg-surface px-2 py-1.5"
        aria-label="System health"
        aria-busy={refreshing || undefined}
      >
        <div className="flex min-w-0 items-center gap-1">
          <HealthDot ok={database?.ok} label="Database" detail={database?.error || (database?.latency_ms != null ? `${database.latency_ms}ms` : '')} />
          <HealthDot ok={storage?.ok} label="Storage" detail={storage?.error || storage?.detail} />
          <HealthDot ok={!backup?.stale} label="Backup" detail={backup ? `${backup.age_hours}h old${backup.stale ? ' — stale' : ''}` : backup?.error} />
          <Link
            to="/admin/system"
            className={cx('num truncate text-[12px] leading-none font-medium hover:underline', problems > 0 ? 'text-attention-deep' : 'text-settled')}
          >
            {/* Short on purpose: the 320px strip truncates long summaries to
                "1…" — two words survive and the dots carry the detail. */}
            {problems > 0 ? `${problems} issue${problems > 1 ? 's' : ''}` : 'OK'}
          </Link>
          {refreshing && <Spinner className="h-3 w-3 shrink-0" />}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cx(
        // Quiet by design (usability audit #3): the amber wash made the card
        // louder than the dashboard it serves. A single muted border — amber
        // only when something is wrong — carries the same signal.
        'rounded-lg border px-2.5 py-2',
        problems > 0 ? 'border-attention/30 bg-surface' : 'border-line bg-surface',
      )}
      aria-label="System health"
      aria-busy={refreshing || undefined}
    >
      <div className="flex items-center gap-1.5">
        <HealthDot ok={database?.ok} label="Database" detail={database?.error || (database?.latency_ms != null ? `${database.latency_ms}ms` : '')} />
        <HealthDot ok={storage?.ok} label="Storage" detail={storage?.error || storage?.detail} />
        <HealthDot ok={!backup?.stale} label="Backup" detail={backup ? `${backup.age_hours}h old${backup.stale ? ' — stale' : ''}` : backup?.error} />
        {/* 12px floor for body-size text (usability audit #2). Links to the
            System page, where the drill-down detail lives. */}
        <Link
          to="/admin/system"
          className={cx('num text-[12px] leading-none font-medium hover:underline', problems > 0 ? 'text-attention-deep' : 'text-settled')}
        >
          {problems > 0 ? `${problems} check${problems > 1 ? 's' : ''} need attention` : 'All systems normal'}
        </Link>
        {refreshing && (
          <span className="ml-auto shrink-0" aria-hidden="true">
            <Spinner className="h-3 w-3" />
          </span>
        )}
      </div>
      <div className="num mt-1.5 text-[12px] leading-none text-ink-faint">
        <div className="flex items-center justify-between gap-2">
          <span>DB</span>
          <span className={cx(database?.ok ? 'text-ink-soft' : 'text-attention-deep font-semibold')}>
            {database?.ok
              ? `${database.latency_ms}ms`
              : (database?.error || 'down')}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span>Storage</span>
          <span className={cx(storage?.ok ? 'text-ink-soft' : 'text-attention-deep font-semibold')}>
            {storage?.ok
              ? (storage.mode === 'remote' ? 'Supabase' : 'Local disk')
              : (storage?.error || 'down')}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span>Backup</span>
          <span className={cx(backup && !backup.stale ? 'text-ink-soft' : 'text-attention-deep font-semibold')}>
            {backup
              ? `${backup.age_hours}h old${backup.stale ? ' — stale' : ''}`
              : (backup?.error || 'none')}
          </span>
        </div>
      </div>
    </div>
  );
}

function ActiveBadge() {
  return (
    <span className="ml-1.5 num rounded-full bg-settled-tint px-1.5 py-0.5 text-[10.5px] font-semibold text-settled">
      Active
    </span>
  );
}

const EXPORT_BY_PATH = {
  '/admin': 'reconciliation',
  '/admin/collection': 'collection',
  '/admin/salesmen': 'salesmen',
  '/admin/bills': 'bills',
  '/admin/cancellations': 'cancellations',
  '/admin/shortages': 'shortages',
  '/admin/cash': 'cash-rollup',
  '/admin/audit': 'audit',
};

// Sidebar quiet actions (sign out, factory reset, dark mode): one shared shape
// so text-level actions still read as buttons — rounded, padded, with hover
// feedback — instead of looking like plain labels. One style, reused 4×.
const QUIET_ACTION = 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left font-medium transition-colors hover:bg-paper';

export default function AdminLayout() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const { user, logout } = useAuth();
  const { push } = useToast();
  const { dark, toggle: toggleDark } = useDarkMode();
  const [exporting, setExporting] = useState(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetWord, setResetWord] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [resetReason, setResetReason] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const onErrorsPage = location.pathname.startsWith('/admin/errors');
  const unreadErrors = useUnreadErrors(onErrorsPage);
  const { health, refreshing } = useSystemHealth();

  // Live updates — subscribe so pages can react to data changes (badge counts etc.)
  useRealtime();
  const { data: pendingSummary, loading: pendingLoading } = useApi('/admin/bills/pending-summary');

  const today = todayISO();
  const from = params.get('from') || shiftISO(today, -6);
  const to = params.get('to') || today;
  const salesmanId = params.get('salesman') || '';

  const setRange = useCallback((next) => {
    const p = new URLSearchParams(params);
    if (next.from) p.set('from', next.from);
    if (next.to) p.set('to', next.to);
    setParams(p, { replace: true });
  }, [params, setParams]);

  const preset = (days) => () => {
    const p = new URLSearchParams(params);
    if (days === 0) { p.set('from', today); p.set('to', today); }
    else { p.set('from', shiftISO(today, -(days - 1))); p.set('to', today); }
    setParams(p, { replace: true });
  };

  const activePreset = useMemo(() => {
    if (from === today && to === today) return 0;
    if (from === shiftISO(today, -6) && to === today) return 7;
    if (from === shiftISO(today, -29) && to === today) return 30;
    return null;
  }, [from, to, today]);

  const report = EXPORT_BY_PATH[location.pathname.replace(/\/$/, '') || '/admin'];
  const exportParams = { from, to, ...(salesmanId ? { salesmanId } : {}) };

  const runExport = async (format) => {
    setExporting(format);
    try {
      const name = await downloadExport(report, exportParams, format);
      push(`${format === 'pdf' ? 'PDF' : 'Excel'} file ready — ${name}`, 'success');
    } catch (err) {
      push(err.message, 'error');
    } finally {
      setExporting(null);
    }
  };

  const rangeValue = useMemo(() => ({ from, to, salesmanId, setRange, setSalesman: (id) => {
    const p = new URLSearchParams(params);
    if (id) p.set('salesman', id); else p.delete('salesman');
    setParams(p, { replace: true });
  } }), [from, to, salesmanId, setRange, params, setParams]);

  return (
    <RangeContext.Provider value={rangeValue}>
      <div className="min-h-full lg:flex lg:items-start">
        {/* Sidebar — pinned on desktop: sticks to the viewport while the
            content column scrolls. The nav gets its own scroll region so all
            ten links stay reachable on short screens. Mobile is unchanged. */}
        <aside className="lg:sticky lg:top-0 lg:h-screen lg:w-[236px] lg:shrink-0 lg:border-r lg:border-line lg:bg-surface lg:flex lg:flex-col lg:overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3.5 lg:block lg:py-5">
            <div>
              <p className="text-[15px] font-semibold tracking-tight">Field Ledger</p>
              <p className="hidden lg:block text-[11.5px] text-ink-faint">Back office</p>
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2 lg:hidden">
              <SystemHealth health={health} refreshing={refreshing} compact />
              <IconBtn label={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggleDark} className="!h-8 !w-8 shrink-0">
                {dark ? (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                )}
              </IconBtn>
              <span className="hidden min-[480px]:inline text-[12px] text-ink-soft">{user?.name}</span>
              {/* The 320px mobile strip has no room for padded button chrome —
                  keep it compact and shrinkable here; the styled quiet actions
                  live in the desktop sidebar footer (usability audit #6). */}
              <button type="button" onClick={logout} className="whitespace-nowrap text-[12px] text-ink-faint underline hover:text-ink">Sign out</button>
            </div>
          </div>
          <nav className="stagger flex gap-0.5 overflow-x-auto px-2 py-2 no-scrollbar snap-x-scroll contain-scroll lg:block lg:flex-1 lg:space-y-0.5 lg:overflow-y-auto lg:px-2 lg:py-3" aria-label="Admin sections">
            {NAV.map((item) => {
              const isActive = item.end
                ? location.pathname === item.to
                : location.pathname.startsWith(item.to);
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  aria-current={isActive ? 'page' : undefined}
                className={() => cx(
                  'snap-start block whitespace-nowrap rounded-lg px-3 py-2.5 min-h-[40px] text-[13.5px] font-medium transition-colors lg:whitespace-normal lg:min-h-0 lg:py-2',
                  isActive ? 'bg-ink text-paper shadow-sm' : 'text-ink-soft hover:bg-paper hover:text-ink',
                )}
                >
                  <span className="flex items-center gap-2.5">
                    {isActive ? (
                      <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-settled" aria-hidden="true" />
                    ) : (
                      <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-line-strong" aria-hidden="true" />
                    )}
                    <span className="flex-1">{item.label}</span>
                    {item.to === '/admin/errors' && unreadErrors > 0 ? (
                      <UnreadBadge count={unreadErrors} />
                    ) : null}
                    {isActive && pendingSummary?.total?.open != null && pendingSummary.total.open > 0 ? (
                      <ActiveBadge />
                    ) : null}
                  </span>
                </NavLink>
              );
            })}
          </nav>
          {/* Mobile: factory reset lives here because the sidebar footer is desktop-only.
              Right-aligned utility link — it must not read as a page-level action. */}
          <div className="flex justify-end border-t border-line px-4 py-1.5 lg:hidden">
            <button type="button" onClick={() => { setResetWord(''); setResetPassword(''); setResetReason(''); setResetOpen(true); }} className="rounded-md px-2 py-1 text-[12px] text-attention-deep hover:bg-attention-tint transition-colors">
              Factory reset…
            </button>
          </div>
          <div className="hidden lg:block lg:shrink-0 border-t border-line px-4 py-4">
            <div className="mb-3">
              <SystemHealth health={health} refreshing={refreshing} />
            </div>
            {pendingLoading ? (
              <div className="flex items-center gap-2 text-[11.5px] text-ink-faint">
                <Spinner className="shrink-0 h-3 w-3" />
                <span>Loading open bills…</span>
              </div>
            ) : pendingSummary?.total ? (
              <div className="text-[11.5px] text-ink-soft">
                <div className="flex items-center justify-between">
                  <span className="text-ink-faint">Open bills this period</span>
                  <span className={cx('num font-semibold', pendingSummary.total.open === 0 ? 'text-settled' : pendingSummary.total.outstanding > 0 ? 'text-attention' : 'text-ink')}>
                    {pendingSummary.total.open} {pendingSummary.total.open === 1 ? 'bill' : 'bills'}
                  </span>
                </div>
                <p className={cx('num mt-0.5', pendingSummary.total.outstanding > 0.5 ? 'text-attention' : 'text-ink-faint')}>
                  <Money value={pendingSummary.total.outstanding} /> outstanding
                </p>
              </div>
            ) : null}
            <div className="mt-4 flex items-center gap-2 text-[12.5px] text-ink-faint">
              <button
                type="button"
                onClick={toggleDark}
                className="flex items-center gap-1.5 text-ink-faint hover:text-ink transition-colors"
              >
                {dark ? (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                )}
                {dark ? 'Light mode' : 'Dark mode'}
              </button>
            </div>
            <button type="button" onClick={logout} className={cx(QUIET_ACTION, 'mt-1 w-full text-[12.5px] text-ink-faint hover:text-ink')}>
              Sign out
            </button>
            <button type="button" onClick={() => { setResetWord(''); setResetPassword(''); setResetReason(''); setResetOpen(true); }} className={cx(QUIET_ACTION, 'mt-1 w-full text-[11.5px] text-attention hover:bg-attention-tint')}>
              Factory reset
            </button>
          </div>
        </aside>

        {/* Content */}
        <div className="flex-1 min-w-0 lg:border-l lg:border-line">
          <header className="sticky top-0 z-20 border-b border-line bg-paper/95 backdrop-blur">
            <div className="px-4 py-2.5 lg:px-7 lg:py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-[16px] font-semibold tracking-tight lg:text-[17px]">
                    {NAV.find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)))?.label || 'Back office'}
                  </h1>
                  <p className="num truncate text-[12px] text-ink-faint">
                    {from === to ? from : `${from} → ${to}`}
                  </p>
                </div>

                {report && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Btn size="sm" onClick={() => runExport('xlsx')} disabled={!!exporting}>
                      {exporting === 'xlsx' ? <Spinner /> : null} Excel
                    </Btn>
                    <Btn size="sm" onClick={() => runExport('pdf')} disabled={!!exporting}>
                      {exporting === 'pdf' ? <Spinner /> : null} PDF
                    </Btn>
                  </div>
                )}
                <RefreshButton label="Refresh data" className="shrink-0" />
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {[[0, 'Today'], [7, '7 days'], [30, '30 days']].map(([d, label]) => (
                  <button
                    key={d}
                    type="button"
                    onClick={preset(d)}
                    className={cx(
                      'rounded-md border px-3 py-2 min-h-[38px] text-[12.5px] font-medium transition-colors touch-target',
                      activePreset === d ? 'border-ink bg-ink text-paper' : 'border-line bg-surface text-ink-soft hover:border-line-strong',
                    )}
                  >
                    {label}
                  </button>
                ))}
                <span className="px-0.5 text-[12px] text-ink-faint">or</span>
                <div className="flex flex-1 flex-wrap items-center gap-1.5 min-[480px]:flex-none">
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setRange({ from: e.target.value })}
                    className="num h-[38px] w-full min-[480px]:w-[130px] rounded-md border border-line bg-surface px-2.5 text-[12.5px] touch-target"
                    aria-label="From date"
                  />
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => setRange({ to: e.target.value })}
                    className="num h-[38px] w-full min-[480px]:w-[130px] rounded-md border border-line bg-surface px-2.5 text-[12.5px] touch-target"
                    aria-label="To date"
                  />
                </div>
              </div>
            </div>
          </header>

          <main key={location.pathname} className="anim-rise px-3 py-4 sm:px-4 sm:py-5 lg:px-7 lg:py-6">
            <Outlet />
          </main>
        </div>
      </div>
      {/* Factory reset confirmation */}
      <Sheet open={resetOpen} onClose={() => setResetOpen(false)} title="Factory reset" footer={
        <>
          <Btn variant="secondary" block onClick={() => setResetOpen(false)} disabled={resetBusy}>Cancel</Btn>
          <Btn block disabled={backupBusy || resetBusy} onClick={async () => {
            setBackupBusy(true);
            try {
              const name = await downloadBackup();
              push(`Backup saved — ${name}`, 'success');
            } catch (err) {
              push(err.message, 'error');
            } finally {
              setBackupBusy(false);
            }
          }}>{backupBusy ? <Spinner /> : null}Download backup</Btn>
          <Btn variant="danger" block disabled={resetWord !== 'DELETE' || !resetPassword || !resetReason.trim() || resetBusy} onClick={async () => {
            setResetBusy(true);
            try {
              await api.post('/admin/factory-reset', { confirm: 'DELETE', password: resetPassword, reason: resetReason.trim() });
              push('All data wiped. Book is empty.', 'success');
              setResetOpen(false);
              window.location.reload();
            } catch (err) {
              push(err.message, 'error');
            } finally {
              setResetBusy(false);
            }
          }}>{resetBusy ? 'Resetting…' : 'Wipe everything'}</Btn>
        </>
      }>
        <p className="text-[13.5px] text-ink-soft mb-3">This permanently deletes <strong>all bills, collections, shops, products, and salesman accounts</strong>. Only admin logins survive.</p>
        <p className="text-[13.5px] text-ink-soft mb-3"><strong className="text-ink">Download the backup first</strong> — it saves every table as CSV files in one zip, so the book can be restored if needed. Then type <strong className="text-attention">DELETE</strong> and enter your password to confirm.</p>
        <Input value={resetWord} onChange={(e) => setResetWord(e.target.value)} placeholder="Type DELETE" mono className="border-attention focus:border-attention" />
        <Field label="Your password" className="mt-3">
          <Input type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} placeholder="Admin password" />
        </Field>
        <Field label="Reason (goes in the audit log)" className="mt-3">
          <Input value={resetReason} onChange={(e) => setResetReason(e.target.value)} placeholder="e.g. End of season — starting a fresh book" maxLength={300} />
        </Field>
      </Sheet>

    </RangeContext.Provider>
  );
}

export function SalesmanFilter({ salesmen, value, onChange }) {
  return (
    <Select
      className="h-9 w-full text-[13px] sm:w-auto sm:max-w-[220px]"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Filter by salesman"
    >
      <option value="">All salesmen</option>
      {(salesmen || []).map((s) => (
        <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
      ))}
    </Select>
  );
}
