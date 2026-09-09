import { NavLink, Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { createContext, useContext, useCallback, useMemo, useState } from 'react';
import { useAuth } from '../lib/context.jsx';
import { downloadExport, downloadBackup, api } from '../lib/api.js';
import { shiftISO, todayISO } from '../lib/format.js';
import { useToast } from '../lib/context.jsx';
import { useDarkMode } from '../lib/hooks.js';
import { useRealtime } from '../lib/realtime.js';
import { useApi } from '../lib/hooks.js';
import { Btn, cx, Field, Input, Select, Sheet, Spinner, Money, RefreshButton } from './ui.jsx';

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
];

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
};

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
  const [backupBusy, setBackupBusy] = useState(false);

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
            <div className="flex items-center gap-2 lg:hidden">
              <button
                type="button"
                onClick={toggleDark}
                className="h-8 w-8 flex items-center justify-center rounded-lg text-ink-faint hover:text-ink hover:bg-paper transition-colors"
                aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {dark ? (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                )}
              </button>
              <span className="text-[12px] text-ink-soft">{user?.name}</span>
              <button type="button" onClick={logout} className="text-[12px] text-ink-faint underline">Sign out</button>
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
                      <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-inset" aria-hidden="true" />
                    )}
                    <span className="flex-1">{item.label}</span>
                    {isActive && pendingSummary?.total?.open != null && pendingSummary.total.open > 0 ? (
                      <ActiveBadge />
                    ) : null}
                  </span>
                </NavLink>
              );
            })}
          </nav>
          {/* Mobile: factory reset lives here because the sidebar footer is desktop-only. */}
          <div className="border-t border-line px-4 py-2 lg:hidden">
            <button type="button" onClick={() => { setResetWord(''); setResetPassword(''); setResetOpen(true); }} className="text-[11.5px] text-attention/70 hover:text-attention transition-colors">
              Factory reset
            </button>
          </div>
          <div className="hidden lg:block lg:shrink-0 border-t border-line px-4 py-4">
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
            <button type="button" onClick={logout} className="mt-2 text-[12.5px] text-ink-faint underline hover:text-ink">
              Sign out
            </button>
            <button type="button" onClick={() => { setResetWord(''); setResetPassword(''); setResetOpen(true); }} className="mt-3 block w-full text-left text-[11.5px] text-attention/70 hover:text-attention transition-colors">
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
                <div className="flex items-center gap-1.5">
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setRange({ from: e.target.value })}
                    className="num h-[38px] rounded-md border border-line bg-surface px-2.5 text-[12.5px] touch-target"
                    aria-label="From date"
                  />
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => setRange({ to: e.target.value })}
                    className="num h-[38px] rounded-md border border-line bg-surface px-2.5 text-[12.5px] touch-target"
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
          <Btn variant="danger" block disabled={resetWord !== 'DELETE' || !resetPassword || resetBusy} onClick={async () => {
            setResetBusy(true);
            try {
              await api.post('/admin/factory-reset', { confirm: 'DELETE', password: resetPassword });
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
