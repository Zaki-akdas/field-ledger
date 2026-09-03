import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useTitle } from '../../lib/hooks.js';
import { todayISO, money } from '../../lib/format.js';
import { Btn, Chips, EmptyState, ErrorNote, Input, Loading, Money, StatusPill, cx } from '../../components/ui.jsx';
import { FieldHeader, QueuedList } from '../../components/FieldLayout.jsx';

const ORDER = { partial: 0, pending: 1, delivered: 2, cancelled: 3 };

export default function Bills({ mode = 'all' }) {
  const collectOnly = mode === 'collect';
  useTitle(collectOnly ? 'To collect' : "Today's bills");
  const today = todayISO();
  const [scope, setScope] = useState('today');
  const [status, setStatus] = useState(collectOnly ? 'open' : 'all');
  const [q, setQ] = useState('');

  const path = scope === 'today' ? `/bills?from=${today}&to=${today}` : '/bills';
  const { data, loading, error } = useApi(path);

  const bills = useMemo(() => {
    let rows = data?.bills || [];
    if (collectOnly) rows = rows.filter((b) => b.status === 'pending' || b.status === 'partial');
    if (status === 'open') rows = rows.filter((b) => b.status === 'pending' || b.status === 'partial');
    else if (status !== 'all') rows = rows.filter((b) => b.status === status);
    if (q.trim()) {
      const needle = q.toLowerCase();
      rows = rows.filter((b) => b.shop_name.toLowerCase().includes(needle)
        || b.invoice_no.toLowerCase().includes(needle)
        || (b.shop_area || '').toLowerCase().includes(needle));
    }
    return [...rows].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || b.amount - a.amount);
  }, [data, status, q, collectOnly]);

  const counts = useMemo(() => {
    const src = (data?.bills || []).filter((b) => (collectOnly ? b.status === 'pending' || b.status === 'partial' : true));
    return {
      all: src.length,
      open: src.filter((b) => b.status === 'pending' || b.status === 'partial').length,
      delivered: src.filter((b) => b.status === 'delivered').length,
      cancelled: src.filter((b) => b.status === 'cancelled').length,
    };
  }, [data, collectOnly]);

  const outstanding = bills
    .filter((b) => b.status === 'pending' || b.status === 'partial')
    .reduce((a, b) => a + (b.balance || 0), 0);

  return (
    <div>
      <FieldHeader
        title={collectOnly ? 'To collect' : "Today's bills"}
        right={(
          <Link to="/field/upload" className="text-[13px] font-medium text-ink-soft underline underline-offset-4">
            Add
          </Link>
        )}
      />

      <div className="mb-3 flex gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search shop or invoice"
          className="h-11 min-h-[44px]"
          aria-label="Search bills"
        />
        <Btn
          size="sm"
          onClick={() => setScope((s) => (s === 'today' ? 'all' : 'today'))}
          className="h-11 min-h-[44px] shrink-0"
          aria-pressed={scope === 'all'}
        >
          {scope === 'today' ? 'Today' : 'All'}
        </Btn>
      </div>

      <Chips
        className="mb-3 -mx-4 px-4"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'all', label: 'All', count: counts.all },
          { value: 'open', label: 'Open', count: counts.open },
          { value: 'delivered', label: 'Delivered', count: counts.delivered },
          { value: 'cancelled', label: 'Cancelled', count: counts.cancelled },
        ]}
      />

      {!collectOnly && counts.open > 0 && (
        <p className="mb-3 text-[12.5px] text-ink-soft">
          <Money value={outstanding} className="font-medium" /> outstanding across{' '}
          <span className="num">{counts.open}</span> open {counts.open === 1 ? 'bill' : 'bills'}
        </p>
      )}

      <ErrorNote className="mb-3">{error?.message}</ErrorNote>

      {loading ? <Loading label="Loading bills…" /> : bills.length === 0 ? (
        <EmptyState
          title={q ? `Nothing matches “${q}”` : status === 'open' ? 'Nothing left to collect' : 'No bills yet — upload today’s batch to start'}
          body={q ? 'Check the spelling or clear the search.' : status === 'open' ? 'Every bill on this list is closed. New ones will appear here.' : 'Drop in the Excel sheet from dispatch, or add a bill by hand.'}
          action={q
            ? <Btn size="sm" onClick={() => setQ('')}>Clear search</Btn>
            : <Link to="/field/upload"><Btn variant="primary" size="sm">Upload bills</Btn></Link>}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          {bills.map((b) => (
            <Link
              key={b.id}
              to={`/field/bills/${b.id}`}
              className="flex items-center gap-3 border-b border-line px-3.5 py-3.5 last:border-0 active:bg-paper min-h-[60px]"
            >
              <div className="min-w-0 flex-1">
                <p className={cx('truncate text-[15px] font-medium', b.status === 'cancelled' && 'line-through text-ink-soft')}>
                  {b.shop_name}
                </p>
                <p className="num mt-0.5 truncate text-[11.5px] text-ink-faint">
                  {b.invoice_no}{b.shop_area ? ` · ${b.shop_area}` : ''}
                </p>
                <div className="mt-1.5 flex gap-1.5">
                  <StatusPill status={b.status} label={{
                    pending: 'Pending', partial: `Part · ₹${money(b.balance)}`, delivered: 'Delivered', cancelled: 'Cancelled',
                  }[b.status]} />
                  {(b.short_amount || 0) > 0 && (
                    <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-soft">
                      Short ₹{money(b.short_amount)}
                    </span>
                  )}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className={cx('num text-[15.5px]', b.status === 'cancelled' && 'text-ink-faint line-through')}>
                  ₹{money(b.amount)}
                </p>
                {(b.collected_amount || 0) > 0 && b.status !== 'delivered' && (
                  <p className="num text-[11.5px] text-settled">₹{money(b.collected_amount)} in</p>
                )}
              </div>
              <svg viewBox="0 0 24 24" width="16" height="16" className="shrink-0 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </Link>
          ))}
        </div>
      )}

      <QueuedList />
    </div>
  );
}
