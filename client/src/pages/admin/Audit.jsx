import { useMemo, useState } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useToast } from '../../lib/context.jsx';
import { downloadExport } from '../../lib/api.js';
import { dateLabel, timeLabel, todayISO, shiftISO } from '../../lib/format.js';
import {
  Btn, Chips, EmptyState, ErrorNote, Input, Loading, Pill, ResponsiveTable, col, cx,
} from '../../components/ui.jsx';

const ACTION_LABEL = {
  delete: 'Deleted',
  purge: 'Hard deleted',
  restore: 'Restored',
  trash_purge: 'Erased from bin',
  trash_sweep: 'Auto-wiped (expired)',
  factory_reset: 'Factory reset',
};
const ACTION_TONE = {
  delete: 'neutral',
  purge: 'attention',
  restore: 'settled',
  trash_purge: 'attention',
  trash_sweep: 'neutral',
  factory_reset: 'attention',
};
const ENTITY_LABEL = { bill: 'Bill', shop: 'Shop', salesman: 'Salesman', trash: 'Trash', system: 'System' };

const ACTIONS = [
  { value: 'all', label: 'All' },
  { value: 'delete', label: 'Deletes' },
  { value: 'purge', label: 'Hard deletes' },
  { value: 'restore', label: 'Restores' },
  { value: 'trash_purge', label: 'Bin erases' },
];

/** Best-effort human summary of the details JSONB bag. */
function detailLine(d) {
  if (!d) return null;
  const parts = [];
  if (d.amount != null) parts.push(<span key="a">₹<span className="num">{Number(d.amount).toLocaleString('en-IN')}</span></span>);
  if (d.bills_removed != null) parts.push(<span key="b" className="num">{d.bills_removed} bill{d.bills_removed === 1 ? '' : 's'}</span>);
  if (d.shop_removed) parts.push(<span key="c">shop also removed</span>);
  if (d.swept != null) parts.push(<span key="d" className="num">{d.swept}</span>);
  if (d.restorable_until) parts.push(<span key="e">restorable until {dateLabel(String(d.restorable_until).slice(0, 10))}</span>);
  return parts.length ? parts.map((p, i) => <span key={i} className="inline-flex items-center gap-1">{i > 0 && <span className="text-ink-faint">·</span>}{p}</span>) : null;
}

const PAGE_SIZE = 50;

export default function Audit() {
  useTitle('Audit log');
  const { push } = useToast();
  const [action, setAction] = useState('all');
  const [exporting, setExporting] = useState(null);
  const [page, setPage] = useState(1);

  // Date range: null = all time (the whole book), else a from/to pair.
  // Local state rather than the header ?range= — the log is office-wide and
  // its exports shouldn't mutate the URL other admin pages share.
  const today = todayISO();
  const [range, setRange] = useState({ from: shiftISO(today, -29), to: today, enabled: false });

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (action !== 'all') p.set('action', action);
    if (range.enabled) { p.set('from', range.from); p.set('to', range.to); }
    p.set('limit', String(PAGE_SIZE));
    p.set('page', String(page));
    return p.toString();
  }, [action, range, page]);

  const { data, loading, error } = useApi(`/admin/audit${params ? `?${params}` : ''}`);
  const entries = data?.entries || [];
  const pages = data?.pages || 1;
  const total = data?.total ?? 0;

  // Any filter change restarts at page 1.
  const setActionPage = (v) => { setAction(v); setPage(1); };
  const setRangePage = (fn) => { setRange(fn); setPage(1); };

  const exportLog = async (format) => {
    setExporting(format);
    try {
      await downloadExport('audit', Object.fromEntries(new URLSearchParams(params)), format);
      const scope = range.enabled ? `${dateLabel(range.from)} → ${dateLabel(range.to)}` : 'all time';
      push(`Audit log (${scope}) exported as ${format.toUpperCase()}.`, 'success');
    } catch (err) {
      push(err.message, 'error');
    } finally {
      setExporting(null);
    }
  };

  const setRangePart = (part) => (e) => setRange((r) => ({ ...r, [part]: e.target.value }));

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <p className="text-[13px] text-ink-soft">
          Every delete, hard delete, restore, and wipe — <span className="num font-medium">{data ? total : '…'}</span> recorded.
          Append-only: entries can never be edited or removed.
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Btn size="sm" onClick={() => exportLog('xlsx')} disabled={!!exporting}>Excel</Btn>
          <Btn size="sm" onClick={() => exportLog('pdf')} disabled={!!exporting}>PDF</Btn>
        </div>
      </div>

      <Chips
        className="mb-3"
        value={action}
        onChange={setActionPage}
        options={ACTIONS.map((a) => ({ ...a, count: undefined }))}
      />

      {/* Date range — applies to the list and both exports together. */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5">
        <button
          type="button"
          onClick={() => setRangePage((r) => ({ ...r, enabled: !r.enabled }))}
          className={cx(
            'rounded-md border px-3 py-2 min-h-[38px] text-[12.5px] font-medium transition-colors',
            range.enabled ? 'border-ink bg-ink text-paper' : 'border-line bg-paper text-ink-soft hover:border-line-strong',
          )}
          aria-pressed={range.enabled}
        >
          {range.enabled ? 'Filtered by date' : 'All time'}
        </button>
        {range.enabled && (
          <>
            <Input type="date" value={range.from} onChange={(e) => { setRangePart('from')(e); setPage(1); }} className="h-10 w-[150px] min-h-[38px]" aria-label="From date" />
            <span className="text-[12px] text-ink-faint">→</span>
            <Input type="date" value={range.to} onChange={(e) => { setRangePart('to')(e); setPage(1); }} className="h-10 w-[150px] min-h-[38px]" aria-label="To date" />
            <span className="text-[12px] text-ink-faint">
              {range.from > range.to ? <span className="text-attention">From is after to</span> : 'filtering the list and both exports'}
            </span>
          </>
        )}
      </div>

      {loading ? <Loading label="Loading the log…" /> : error ? <ErrorNote>{error.message}</ErrorNote> : entries.length === 0 ? (
        <EmptyState
          icon="📜"
          title="Nothing recorded"
          body={range.enabled || action !== 'all'
            ? 'No entries match these filters — widen the date range or switch the action filter.'
            : 'Deletes, restores and purges will appear here with who did them and when.'}
        />
      ) : (
        <ResponsiveTable
          className="max-h-[70vh] overflow-y-auto"
          cols={[
            col('When', (e) => (
              <span>
                <span className="block whitespace-nowrap text-[13px]">{dateLabel(String(e.created_at).slice(0, 10))}</span>
                <span className="num block whitespace-nowrap text-[11.5px] text-ink-faint">{timeLabel(e.created_at)}</span>
              </span>
            ), null, 'top'),
            col('Action', (e) => (
              <Pill tone={ACTION_TONE[e.action] || 'neutral'}>{ACTION_LABEL[e.action] || e.action}</Pill>
            ), null, 'mid'),
            col('What', (e) => (
              <span>
                <span className="block text-[13.5px] font-medium">{e.label || '—'}</span>
                <span className="text-[11.5px] text-ink-faint">
                  {ENTITY_LABEL[e.entity] || e.entity}
                  {e.entity_id != null && <span className="num"> #{e.entity_id}</span>}
                  {detailLine(e.details) && <span className="ml-1.5 inline-flex items-center gap-1 text-ink-soft">· {detailLine(e.details)}</span>}
                </span>
              </span>
            )),
            col('By', (e) => (
              <span className="whitespace-nowrap">
                {e.actor_code && <span className="num mr-1.5 text-[11.5px] text-ink-faint">{e.actor_code}</span>}
                {e.actor_name}
              </span>
            )),
          ]}
          rows={entries}
          empty={<p className="py-10 text-center text-ink-faint">No entries for this filter.</p>}
        />
      )}

      {/* Pager — only meaningful when there is more than one page. */}
      {pages > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2.5">
          <p className="num text-[12.5px] text-ink-soft">
            Page <span className="font-medium text-ink">{data?.page || page}</span> of{' '}
            <span className="font-medium text-ink">{pages}</span>
            {' '}· {total} {total === 1 ? 'entry' : 'entries'}
          </p>
          <div className="flex items-center gap-1.5">
            <Btn size="sm" onClick={() => setPage(1)} disabled={page <= 1}>First</Btn>
            <Btn size="sm" onClick={() => setPage((p) => Math.max(p - 1, 1))} disabled={page <= 1}>Prev</Btn>
            <Btn size="sm" onClick={() => setPage((p) => Math.min(p + 1, pages))} disabled={page >= pages}>Next</Btn>
            <Btn size="sm" onClick={() => setPage(pages)} disabled={page >= pages}>Last</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
