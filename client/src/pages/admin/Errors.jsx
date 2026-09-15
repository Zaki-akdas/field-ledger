import { useMemo, useState } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useToast } from '../../lib/context.jsx';
import { dateLabel, timeLabel, todayISO, shiftISO } from '../../lib/format.js';
import {
  Btn, Chips, EmptyState, ErrorNote, Input, Loading, Pill, ResponsiveTable, col, cx,
} from '../../components/ui.jsx';

const KIND_TONE = {
  react_render: 'attention',
  window_error: 'attention',
  unhandled_rejection: 'attention',
  api_5xx: 'attention',
  uncaughtException: 'attention',
  unhandledRejection: 'attention',
  request_error: 'attention',
};

const KIND_LABEL = {
  react_render: 'Render crash',
  window_error: 'Window error',
  unhandled_rejection: 'Unhandled promise',
  api_5xx: 'API 5xx',
  uncaughtException: 'Uncaught (server)',
  unhandledRejection: 'Unhandled promise (server)',
  request_error: 'Failed request (server)',
};

const SOURCES = [
  { value: 'all', label: 'All' },
  { value: 'client', label: 'Phone' },
  { value: 'server', label: 'Server' },
];

const PAGE_SIZE = 50;

export default function Errors() {
  useTitle('Errors');
  const { push } = useToast();
  const [source, setSource] = useState('all');
  const [kind, setKind] = useState('all');
  const [search, setSearch] = useState('');
  const [searchLive, setSearchLive] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(null);

  const today = todayISO();
  const [range, setRange] = useState({ from: shiftISO(today, -29), to: today, enabled: false });

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (source !== 'all') p.set('source', source);
    if (kind !== 'all') p.set('kind', kind);
    if (search.trim()) p.set('search', search.trim());
    if (range.enabled) { p.set('from', range.from); p.set('to', range.to); }
    p.set('limit', String(PAGE_SIZE));
    p.set('page', String(page));
    return p.toString();
  }, [source, kind, search, range, page]);

  const { data, loading, error } = useApi(`/admin/errors${params ? `?${params}` : ''}`);
  const entries = data?.entries || [];
  const pages = data?.pages || 1;
  const total = data?.total ?? 0;
  const kinds = data?.facets?.kinds || [];

  const resetPage = (fn) => { fn(); setPage(1); };
  const setKindPage = (v) => resetPage(() => setKind(v));
  const setSearchPage = (v) => { setSearch(v); setSearchLive(v); setPage(1); };

  const exportErrors = async (format) => {
    setExporting(format);
    try {
      // The generic report endpoint doesn't know this report; ship the exact
      // same filter set as the list as CSV instead.
      const qs = new URLSearchParams(params);
      qs.delete('limit'); qs.delete('page');
      const res = await fetch(`/api/admin/errors.csv?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('field-ledger:token')}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status}).`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `field-ledger-errors-${today}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      push(`Error log exported as ${format.toUpperCase()}.`, 'success');
    } catch (err) {
      push(err.message, 'error');
    } finally {
      setExporting(null);
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <p className="text-[13px] text-ink-soft">
          Client crashes and server faults, newest first — <span className="num font-medium">{data ? total : '…'}</span> recorded.
          Every failed request and render crash lands here automatically.
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Btn size="sm" onClick={() => exportErrors('csv')} disabled={!!exporting}>CSV</Btn>
        </div>
      </div>

      <Chips
        className="mb-3"
        value={source}
        onChange={(v) => resetPage(() => setSource(v))}
        options={SOURCES}
      />

      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          type="search"
          value={searchLive}
          onChange={(e) => setSearchPage(e.target.value)}
          placeholder="Search message, stack or user code…"
          className="h-10 min-h-[38px] sm:max-w-xs"
          aria-label="Search errors"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => resetPage(() => setRange((r) => ({ ...r, enabled: !r.enabled })))}
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
              <Input type="date" value={range.from} onChange={(e) => resetPage(() => setRange((r) => ({ ...r, from: e.target.value })))} className="h-10 w-[145px] min-h-[38px]" aria-label="From date" />
              <span className="text-[12px] text-ink-faint">→</span>
              <Input type="date" value={range.to} onChange={(e) => resetPage(() => setRange((r) => ({ ...r, to: e.target.value })))} className="h-10 w-[145px] min-h-[38px]" aria-label="To date" />
            </>
          )}
        </div>
      </div>

      {/* Kind chips come from the data itself so new kinds surface on their own. */}
      {kinds.length > 0 && (
        <Chips
          className="mb-3"
          value={kind}
          onChange={setKindPage}
          options={[
            { value: 'all', label: 'Every kind' },
            ...kinds.map((k) => ({ value: k.kind, label: KIND_LABEL[k.kind] || k.kind, count: undefined })),
          ]}
        />
      )}

      {loading ? <Loading label="Loading errors…" /> : error ? <ErrorNote>{error.message}</ErrorNote> : entries.length === 0 ? (
        <EmptyState
          icon="🩹"
          title="No errors recorded"
          body={source !== 'all' || kind !== 'all' || search || range.enabled
            ? 'Nothing matches these filters — widen the range or clear the search.'
            : 'Quiet book. Client crashes and server faults will appear here as they happen.'}
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
            col('Source', (e) => (
              <Pill tone={e.source === 'client' ? 'attention' : 'neutral'}>{e.source === 'client' ? 'Phone' : 'Server'}</Pill>
            ), null, 'mid'),
            col('Error', (e) => (
              <span className="block max-w-[420px]">
                <Pill tone={KIND_TONE[e.kind] || 'neutral'} className="mb-1">{KIND_LABEL[e.kind] || e.kind}</Pill>
                <span className="block text-[13px] font-medium leading-snug break-words">{e.message}</span>
                {e.url && <span className="num block truncate text-[11px] text-ink-faint" title={e.url}>{e.url}</span>}
              </span>
            )),
            col('User', (e) => (
              <span className="whitespace-nowrap">
                {e.user_code
                  ? (<><span className="num mr-1.5 text-[11.5px] text-ink-faint">{e.user_code}</span>{e.user_name || ''}</>)
                  : <span className="text-ink-faint">signed out</span>}
              </span>
            )),
            col('More', (e) => (
              e.stack
                ? <details className="max-w-[360px]"><summary className="cursor-pointer text-[12px] text-ink-soft hover:text-ink">Stack</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-paper p-2 text-left text-[10.5px] leading-snug text-ink-soft">{e.stack}</pre></details>
                : <span className="text-ink-faint">—</span>
            )),
          ]}
          rows={entries}
          empty={<p className="py-10 text-center text-ink-faint">No errors for this filter.</p>}
        />
      )}

      {pages > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2.5">
          <p className="num text-[12.5px] text-ink-soft">
            Page <span className="font-medium text-ink">{data?.page || page}</span> of{' '}
            <span className="font-medium text-ink">{pages}</span>
            {' '}· {total} {total === 1 ? 'report' : 'reports'}
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
