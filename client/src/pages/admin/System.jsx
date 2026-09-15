import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useTitle } from '../../lib/hooks.js';
import { api } from '../../lib/api.js';
import { dateLabel, timeLabel } from '../../lib/format.js';
import { Btn, cx, EmptyState, Loading, Pill } from '../../components/ui.jsx';

/**
 * System health drill-down: live /api/status snapshot, a latency history
 * sparkline built from this browser's own polls (a lightweight substitute
 * for an external metrics store — history is per-tab, kept in memory), the
 * stored-backup list with downloads, and pointers to the Errors page and
 * the backups docs.
 */

const POLL_MS = 60_000;
const HISTORY_MAX = 60; // one hour of minutes

const fmtSize = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

/** Inline SVG sparkline for [{ v }] — normalized, no library. */
function Sparkline({ points, threshold }) {
  const w = 560;
  const h = 90;
  const pad = 4;
  if (points.length < 2) {
    return <p className="text-[12.5px] text-ink-faint">Collecting history — one point per minute while this page is open.</p>;
  }
  const max = Math.max(threshold, ...points.map((p) => p.v)) * 1.1;
  const x = (i) => pad + (i / (points.length - 1)) * (w - 2 * pad);
  const y = (v) => h - pad - (v / max) * (h - 2 * pad);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${path} L${x(points.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
  const breached = threshold != null && points.some((p) => p.v > threshold);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={`Database latency, last ${points.length} minutes`}>
      {threshold != null && threshold <= max && (
        <line x1={pad} x2={w - pad} y1={y(threshold)} y2={y(threshold)} strokeDasharray="4 4" className="stroke-attention" strokeWidth="1" />
      )}
      <path d={area} fillOpacity="0.1" className={breached ? 'fill-attention' : 'fill-settled'} />
      <path d={path} fill="none" strokeWidth="1.5" className={breached ? 'stroke-attention' : 'stroke-settled'} />
    </svg>
  );
}

function CheckRow({ label, ok, value, detail }) {
  return (
    <div className="flex items-start justify-between gap-3 border-t border-line py-2 first:border-t-0">
      <div className="flex items-center gap-2">
        <span className={cx('h-2 w-2 shrink-0 rounded-full', ok ? 'bg-settled' : 'bg-attention')} aria-hidden="true" />
        <span className="text-[13px] font-medium">{label}</span>
      </div>
      <div className="text-right">
        <p className={cx('num text-[13px]', ok ? 'text-ink' : 'font-semibold text-attention-deep')}>{value}</p>
        {detail && <p className="num text-[11px] text-ink-faint">{detail}</p>}
      </div>
    </div>
  );
}

export default function System() {
  useTitle('System');
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState(null);
  // Mirrors the sidebar health card: true only while a focus/online/visibility
  // refresh is in flight, so the header shows the snapshot is being re-probed.
  const [refreshing, setRefreshing] = useState(false);
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('field-ledger:latency-history') || '[]'); } catch { return []; }
  });
  const historyRef = useRef(history);
  historyRef.current = history;
  const statusRef = useRef(null); // freshest snapshot, readable by the poll loop

  // Live status poll — 503 during an outage is a valid answer carrying the
  // checks (err.body), so outages render as data, never as a crashed page.
  // Each poll also appends the DB latency to this tab's history.
  useEffect(() => {
    let alive = true;
    let timer;
    let lastStarted = 0; // debounce: tab-switch flurries fire one refresh
    const poll = async () => {
      lastStarted = Date.now();
      try {
        const body = await api.get('/status');
        if (alive) { setStatus(body); setStatusErr(null); }
      } catch (err) {
        if (alive && err?.body?.checks) { setStatus(err.body); setStatusErr(null); }
        else if (alive) setStatusErr(err.message);
      }
      const lat = statusRef.current?.checks?.database?.latency_ms;
      // Focus refreshes can land well inside the 60s cadence; a point closer
      // than 45s to its predecessor would corrupt the "one point per minute"
      // series — the status card still updates, only the history point is skipped.
      const lastPoint = historyRef.current[historyRef.current.length - 1];
      if (lat != null && (!lastPoint || Date.now() - lastPoint.t >= 45_000)) {
        const next = [...historyRef.current, { t: Date.now(), v: lat }].slice(-HISTORY_MAX);
        historyRef.current = next;
        try { sessionStorage.setItem('field-ledger:latency-history', JSON.stringify(next)); } catch { /* quota */ }
        if (alive) setHistory(next);
      }
      if (alive) { setRefreshing(false); timer = setTimeout(poll, POLL_MS); }
    };
    // Same contract as the sidebar health indicator (identical timing, so the
    // two always agree): refresh when the tab is shown, the window regains
    // focus, or connectivity returns — but only if the last poll isn't brand
    // new (min 10s between refreshes). Deferred 150ms to let the focus paint land.
    const refreshSoon = () => {
      if (!alive) return;
      if (Date.now() - lastStarted < 10_000) return;
      clearTimeout(timer);
      setRefreshing(true);
      timer = setTimeout(poll, 150);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') refreshSoon(); };
    window.addEventListener('focus', refreshSoon);
    window.addEventListener('online', refreshSoon);
    document.addEventListener('visibilitychange', onVisible);
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener('focus', refreshSoon);
      window.removeEventListener('online', refreshSoon);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  statusRef.current = status;

  const { data: backupsData, loading: backupsLoading, error: backupsError } = useApi('/admin/backups');
  const backups = backupsData?.backups || [];
  const [downloading, setDownloading] = useState(null);

  const download = async (name) => {
    setDownloading(name);
    try {
      const res = await fetch(`/api/admin/backups/download?name=${encodeURIComponent(name)}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('field-ledger:token')}` },
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({}));
        throw new Error(msg.error || `Download failed (${res.status}).`);
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } finally {
      setDownloading(null);
    }
  };

  const checks = status?.checks;
  const db = checks?.database;
  const backup = checks?.backup;
  const stale = Boolean(backup?.stale);

  const summary = useMemo(() => {
    if (!history.length) return null;
    const vs = history.map((p) => p.v);
    return { min: Math.min(...vs), max: Math.max(...vs), avg: Math.round(vs.reduce((a, b) => a + b, 0) / vs.length) };
  }, [history]);

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-soft">
        Live infrastructure health — the same <span className="num">/api/status</span> feed external
        uptime checkers watch (see <span className="font-medium">Production checklist → Monitoring</span>).
        Polls every minute while this page is open.
      </p>

      {statusErr && (
        <div className="rounded-lg border border-attention bg-attention-tint px-3 py-2.5 text-[13px] text-attention-deep">
          Status endpoint unreachable — {statusErr}. The server may be restarting.
        </div>
      )}

      {!status && !statusErr ? (
        <Loading label="Probing database and storage…" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Live snapshot */}
          <section className="rounded-xl border border-line bg-surface p-4" aria-label="Live status">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[14px] font-semibold">Live status</h2>
              <span className="num text-[11px] text-ink-faint">
                {refreshing
                  ? 'refreshing…'
                  : status?.time ? `as of ${timeLabel(status.time)}` : ''}
              </span>
            </div>
            {checks ? (
              <>
                <CheckRow
                  label="Database"
                  ok={db?.ok}
                  value={db?.ok ? `${db.latency_ms}ms` : 'down'}
                  detail={db?.error || undefined}
                />
                <CheckRow
                  label="Storage"
                  ok={checks.storage?.ok}
                  value={checks.storage?.ok ? (checks.storage.mode === 'remote' ? 'Supabase' : 'Local disk') : 'down'}
                  detail={checks.storage?.error || checks.storage?.detail || undefined}
                />
                <CheckRow
                  label="Backup"
                  ok={!stale}
                  value={backup ? `${backup.age_hours}h old${stale ? ' — stale' : ''}` : 'none'}
                  detail={backup?.name || backup?.error || undefined}
                />
              </>
            ) : null}
            {stale && (
              <p className="mt-2 rounded-lg bg-attention-tint px-3 py-2 text-[12.5px] text-attention-deep">
                Newest backup is past the 26-hour freshness line — the daily backup workflow likely
                stopped. Check GitHub → Actions → backup.
              </p>
            )}
          </section>

          {/* Latency history */}
          <section className="rounded-xl border border-line bg-surface p-4" aria-label="Latency history">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-[14px] font-semibold">DB latency — last hour</h2>
              {summary && (
                <span className="num text-[11px] text-ink-faint">
                  min {summary.min}ms · avg {summary.avg}ms · max {summary.max}ms
                </span>
              )}
            </div>
            <Sparkline points={history} threshold={2000} />
            <p className="mt-1 text-[11px] text-ink-faint">
              Dashed line: the 2s alert threshold from the monitoring checklist. History is kept in this
              browser tab only (one point per poll) — external monitors keep the authoritative record.
            </p>
          </section>
        </div>
      )}

      {/* Stored backups */}
      <section className="rounded-xl border border-line bg-surface p-4" aria-label="Stored backups">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold">Stored backups</h2>
          <span className="num text-[11px] text-ink-faint">
            newest {backups.length ? `· ${backups.length} kept` : ''}
          </span>
        </div>
        {backupsLoading ? (
          <Loading label="Listing backups…" />
        ) : backupsError ? (
          <p className="text-[13px] text-attention-deep">Could not list backups — {backupsError.message}</p>
        ) : backups.length === 0 ? (
          <EmptyState
            title="No stored backups yet"
            body="Scheduled backups (GitHub Actions → backup, or npm run backup on a host) land in storage and appear here."
          />
        ) : (
          <ul className="divide-y divide-line">
            {backups.map((b, i) => (
              <li key={b.name} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="num truncate text-[13px]">{b.name}</p>
                  <p className="num text-[11px] text-ink-faint">
                    {dateLabel(String(b.created_at).slice(0, 10))} {timeLabel(b.created_at)} · {fmtSize(b.size)}
                    {i === 0 && <span className="ml-1.5"><Pill tone="settled">newest</Pill></span>}
                  </p>
                </div>
                <Btn
                  size="sm"
                  onClick={() => download(b.name)}
                  disabled={downloading === b.name}
                  aria-label={`Download ${b.name}`}
                >
                  {downloading === b.name ? '…' : 'Download'}
                </Btn>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11.5px] text-ink-faint">
          These are the scheduled full-book zips (password hashes included). The factory-reset sheet's
          download is a separate safety copy taken at wipe time.
        </p>
      </section>

      {/* Where to next */}
      <section className="grid gap-3 sm:grid-cols-2" aria-label="Related">
        <Link
          to="/admin/errors"
          className="rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
        >
          <h3 className="text-[14px] font-semibold">Errors page →</h3>
          <p className="mt-1 text-[12.5px] text-ink-soft">
            Client crashes and server faults, newest first. If something here is failing, the cause is often there.
          </p>
        </Link>
        <details className="rounded-xl border border-line bg-surface p-4">
          <summary className="cursor-pointer text-[14px] font-semibold">Backups &amp; restore — quick reference</summary>
          <div className="mt-2 space-y-2 text-[12.5px] text-ink-soft">
            <p><span className="num font-medium text-ink">npm run backup</span> — full-book zip of every table to Supabase Storage <span className="num">backups/</span> (or server/backups/ on disk). Retention: newest <span className="num">BACKUP_KEEP</span> (default 14).</p>
            <p><span className="num font-medium text-ink">npm run restore -- &lt;zip&gt; --list</span> — inspect a backup's row counts before restoring. Full procedure: README → Backups &amp; restore; launch rules: PRODUCTION-CHECKLIST.md → Backups.</p>
            <p>Scheduling lives in <span className="num">.github/workflows/backup.yml</span> (daily 01:30 UTC). A stale list above means that workflow stopped.</p>
          </div>
        </details>
      </section>
    </div>
  );
}
