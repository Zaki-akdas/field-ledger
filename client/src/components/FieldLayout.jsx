import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuth, useSync } from '../lib/context.jsx';
import { useApi, useDarkMode } from '../lib/hooks.js';
import { useRealtime } from '../lib/realtime.js';
import { todayISO, money } from '../lib/format.js';
import { cx, Money, Spinner } from './ui.jsx';

const NAV = [
  { to: '/field/bills', label: 'Bills', icon: 'M4 6h16M4 12h16M4 18h10' },
  { to: '/field/collect', label: 'Collect', icon: 'M3 7h18v10H3zM3 11h18' },
  { to: '/field/me', label: 'Me', icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 0116 0' },
];

function NavIcon({ path }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

export default function FieldLayout() {
  const { user } = useAuth();
  const { online, queue, flushing, flush } = useSync();
  const location = useLocation();
  const today = todayISO();
  const { dark, toggle: toggleDark } = useDarkMode();
  const { data, loading, reload } = useApi(`/me/dashboard?from=${today}&to=${today}`, [location.pathname, queue.length]);

  // Live updates — when a collection or bill changes, refresh the dashboard
  const { connected: rtConnected } = useRealtime(null, (event) => {
    if (event.table === 'collections' || event.table === 'bills') {
      reload();
    }
  });

  useEffect(() => { reload(); }, [location.key, reload]);

  // A salesman pockets the phone at every shop; refresh when it comes back up.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  const collected = data?.collected ?? 0;
  // Today's overall book: expected is billed minus cancellations and shorts, so
  // billed = expected + cancelled + short; outstanding = pending amount.
  const billed = (data?.expected ?? 0) + (data?.cancelled?.amount ?? 0) + (data?.short?.amount ?? 0);
  const due = data?.pending?.amount ?? 0;
  const pendingCount = (data?.bills?.pending || 0) + (data?.bills?.partial || 0);
  const deliveredCount = data?.bills?.delivered ?? 0;
  // A subtle green tick once everything on today's book has come in — only
  // when there actually is a book (an empty day never shows it).
  const allCollected = billed > 0 && collected >= billed - 0.5;

  return (
    <div className="min-h-full">
      {/* Running total — always visible, the number a salesman checks first. */}
      <header className="sticky top-0 z-30 border-b border-line bg-paper/95 backdrop-blur safe-top">
        <div className="mx-auto flex max-w-[560px] items-center justify-between gap-3 px-3 py-2.5 sm:px-4">
          <NavLink
            to="/field/me"
            aria-label="My numbers — full day breakdown"
            title="My numbers — full day breakdown"
            className="group min-w-0 block rounded-lg px-0.5 py-0.5 -ml-0.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink active:opacity-70"
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
              Today · {new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
            </p>
            <p className="num text-[22px] leading-tight font-medium">
              {loading && !data ? <span className="text-ink-faint text-base">…</span> : <Money value={collected} />}
              {allCollected && (
                <svg
                  role="img"
                  aria-label="Everything collected today"
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="ml-1.5 inline text-settled"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
              <span className="ml-2 text-[11.5px] font-sans font-normal text-ink-faint">collected</span>
            </p>
            <p className="num mt-0.5 text-[11.5px] leading-tight text-ink-soft">
              {loading && !data ? '…' : (
                <>
                  billed <span className="font-medium text-ink">₹{money(billed)}</span>
                  {' · '}due <span className="font-medium text-ink">₹{money(due)}</span>
              {' · '}<span className={pendingCount > 0 ? 'text-attention-deep font-medium' : ''}>{pendingCount}</span> pending
                  {' · '}<span className="font-medium">{deliveredCount}</span> delivered
                </>
              )}
              <svg
                viewBox="0 0 24 24"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="ml-1 inline text-ink-faint transition-transform group-hover:translate-x-0.5"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </p>
          </NavLink>
          <div className="flex items-center gap-2">
            {!online && (
              <span className="rounded-full border border-attention/40 bg-attention-tint px-2.5 py-1 text-[11px] font-medium text-attention-deep">
                Offline
              </span>
            )}
            <span
              className={cx('h-2 w-2 rounded-full', online ? (rtConnected ? 'bg-settled animate-pulse' : 'bg-settled') : 'bg-attention')}
              title={online ? (rtConnected ? 'Live — changes sync in real-time' : 'Connected') : 'No connection'}
            />
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
            <span className="hidden sm:inline text-[12px] text-ink-soft">{user?.name}</span>
          </div>
        </div>
      </header>

      {queue.length > 0 && (
        <div className="border-b border-attention/25 bg-attention-tint">
          <div className="mx-auto flex max-w-[560px] items-center justify-between gap-3 px-4 py-2">
            <p className="text-[12.5px] text-attention-deep">
              <span className="num font-medium">{queue.length}</span>
              {' '}{queue.length === 1 ? 'entry is' : 'entries are'} waiting to sync
              {flushing && <Spinner className="ml-2" />}
            </p>
            <button
              type="button"
              onClick={flush}
              disabled={flushing || !online}
              className="rounded-md border border-attention/40 bg-surface px-2.5 py-1 text-[12px] font-medium text-attention-deep disabled:opacity-50"
            >
              {online ? 'Sync now' : 'No signal'}
            </button>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-[560px] px-3 pb-28 pt-3 sm:px-4 sm:pt-4">
        <Outlet context={{ pendingCount, summary: data, reloadSummary: reload }} />
      </main>

      <nav className="fixed bottom-0 inset-x-0 z-30 border-t border-line bg-surface/95 backdrop-blur safe-bottom">
        <div className="mx-auto flex max-w-[560px]">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => cx(
                'flex-1 flex flex-col items-center justify-center gap-1 py-2 text-[11.5px] font-medium transition-colors min-h-[48px] touch-target',
                isActive ? 'text-ink' : 'text-ink-faint hover:text-ink-soft',
              )}
            >
              {({ isActive }) => (
                <>
                  <span className={cx('relative', isActive && 'text-settled')}>
                    <NavIcon path={item.icon} />
                    {item.to === '/field/collect' && pendingCount > 0 && (
                      <span className="absolute -right-2 -top-1.5 num flex h-4 min-w-4 items-center justify-center rounded-full bg-attention px-1 text-[10px] font-semibold text-white">
                        {pendingCount}
                      </span>
                    )}
                  </span>
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

export function FieldHeader({ title, back, right }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      {back && (
        <NavLink
          to={back}
          aria-label="Back"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-soft hover:text-ink"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </NavLink>
      )}
      <h1 className="flex-1 truncate text-[19px] font-semibold tracking-tight">{title}</h1>
      {right}
    </div>
  );
}

export function QueuedList() {
  const { queue } = useSync();
  if (!queue.length) return null;
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface">
      <p className="border-b border-line px-3.5 py-2 text-[12px] font-medium uppercase tracking-wider text-ink-faint">
        Waiting to sync
      </p>
      <ul className="divide-y divide-line">
        {queue.map((op) => (
          <li key={op.id} className="flex items-center gap-3 px-3.5 py-2.5 text-[13.5px]">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-attention" />
            <span className="flex-1 truncate text-ink-soft">{op.label || op.type}</span>
            {op.error && <span className="text-[12px] text-attention truncate max-w-[45%]">{op.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

