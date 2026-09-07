import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminOriginState } from '../../lib/adminBack.js';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useRange, SalesmanFilter } from '../../components/AdminLayout.jsx';
import { useToast } from '../../lib/context.jsx';
import { api } from '../../lib/api.js';
import { relativeTime } from '../../lib/format.js';
import {
  Btn, ErrorNote, Loading, Money, ResponsiveTable, Variance, col, cx,
} from '../../components/ui.jsx';

const COLUMNS = [
  { key: 'code', label: 'Salesman', align: 'left' },
  { key: 'bill_count', label: 'Bills', align: 'right', hide: 'hidden md:table-cell' },
  { key: 'billed', label: 'Billed', align: 'right', hide: 'hidden xl:table-cell' },
  { key: 'cancelled_amount', label: 'Cancelled', align: 'right', hide: 'hidden lg:table-cell' },
  { key: 'short_amount', label: 'Short', align: 'right', hide: 'hidden xl:table-cell' },
  { key: 'expected', label: 'Expected', align: 'right' },
  { key: 'by_mode.cash', label: 'Cash', align: 'right', hide: 'hidden xl:table-cell' },
  { key: 'collected', label: 'Collected', align: 'right' },
  { key: 'variance', label: 'Variance', align: 'right' },
  { key: 'day_ended', label: 'Today', align: 'left', hide: 'hidden lg:table-cell' },
  { key: 'last_activity', label: 'Last entry', align: 'left', hide: 'hidden xl:table-cell' },
];

const get = (obj, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);

export default function Salesmen() {
  useTitle('Salesmen');
  const { from, to, salesmanId, setSalesman } = useRange();
  const navigate = useNavigate();
  const [sort, setSort] = useState({ key: 'variance', dir: 'desc' });
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const { push } = useToast();
  const { data, loading, error, reload } = useApi(`/admin/salesmen?from=${from}&to=${to}${salesmanId ? `&salesmanId=${salesmanId}` : ''}`);
  const people = useApi('/salesmen');

  const rows = useMemo(() => {
    const list = data?.salesmen || [];
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = get(a, sort.key); const bv = get(b, sort.key);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [data, sort]);

  const totals = useMemo(() => (data?.salesmen || []).reduce((acc, r) => ({
    bills: acc.bills + r.bill_count,
    expected: acc.expected + r.expected,
    collected: acc.collected + r.collected,
    variance: acc.variance + r.variance,
  }), { bills: 0, expected: 0, collected: 0, variance: 0 }), [data]);

  const toggle = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'code' ? 'asc' : 'desc' }));

  /* ---- selection ---- */
  const toggleSelect = (id, e) => {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  /* ---- single delete ---- */
  const handleDelete = async (r, e) => {
    e.stopPropagation();
    if (!window.confirm(`Delete ${r.name} (${r.code})? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.del(`/admin/salesmen/${r.id}`);
      push(`Deleted ${r.name}.`, 'success');
      reload();
      if (people.reload) people.reload();
    } catch (err) {
      push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ---- bulk delete ---- */
  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} salesman${selected.size > 1 ? 's' : ''}? Those with bills will be skipped.`)) return;
    setBusy(true);
    try {
      const r = await api.post('/admin/salesmen/delete', { ids: [...selected] });
      const n = r.deleted?.length || 0;
      const skip = r.skipped?.length || 0;
      push(n ? `Deleted ${n} salesman${n > 1 ? 's' : ''}${skip ? `, skipped ${skip}` : ''}.` : 'Nothing was deleted.', n ? 'success' : 'error');
      setSelected(new Set());
      reload();
      if (people.reload) people.reload();
    } catch (err) {
      push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading label="Adding up salesmen…" />;
  if (error) return <ErrorNote>{error.message}</ErrorNote>;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-ink-soft">
          <span className="num font-medium">{(data?.salesmen || []).length}</span> salesmen ·{' '}
          <span className="num font-medium">{totals.bills}</span> bills in this period
        </p>
        <SalesmanFilter salesmen={people.data?.salesmen} value={salesmanId} onChange={setSalesman} />
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm dark:bg-red-950/30">
          <span className="font-medium text-red-700 dark:text-red-300">{selected.size} selected</span>
          <Btn size="sm" variant="danger" onClick={handleBulkDelete} disabled={busy}>Delete selected</Btn>
          <Btn size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Btn>
        </div>
      )}

      <ResponsiveTable
        cols={[
          col('', (r) => (
            <input
              type="checkbox"
              checked={selected.has(r.id)}
              onChange={(e) => toggleSelect(r.id, e)}
              className="h-4 w-4 cursor-pointer accent-red-500"
              aria-label={`Select ${r.code}`}
            />
          ), 'center', 'grid'),
          ...COLUMNS.map((c) => col(
            c.label,
            (r) => {
              switch (c.key) {
                case 'code':
                  return (
                    <span>
                      <span className="num text-[11.5px] text-ink-faint">{r.code}</span>
                      <span className="block text-[13.5px] font-medium">{r.name}</span>
                    </span>
                  );
                case 'bill_count': return r.bill_count;
                case 'billed': return <Money value={r.billed} />;
                case 'cancelled_amount':
                  return r.cancelled_count > 0
                    ? <span className="text-attention"><Money value={r.cancelled_amount} /><span className="text-ink-faint"> · {r.cancelled_count}</span></span>
                    : null;
                case 'short_amount':
                  return r.short_amount > 0 ? <span className="text-attention"><Money value={r.short_amount} /></span> : null;
                case 'expected': return <Money value={r.expected} />;
                case 'by_mode.cash': return <Money value={r.by_mode.cash} />;
                case 'collected': return <Money value={r.collected} />;
                case 'variance': return <Variance value={r.variance} />;
                case 'day_ended':
                  return r.day_ended
                    ? <span className="text-settled">Ended {r.day_ended}</span>
                    : r.day_started
                      ? <span className="text-ink-soft">On route since {r.day_started}</span>
                      : null;
                case 'last_activity': return relativeTime(r.last_activity);
                default: return null;
              }
            },
            c.align,
            c.key === 'code' ? 'top'
              : ['bill_count', 'expected', 'collected', 'variance'].includes(c.key) ? 'grid'
                : null,
            () => (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggle(c.key); }}
                className={cx('inline-flex items-center gap-1 hover:text-ink', sort.key === c.key && 'text-ink')}
              >
                {c.label}
                {sort.key === c.key && <span className="text-[9px]">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
              </button>
            ),
          )),
          col('', (r) => (
            <Btn
              size="sm"
              variant="ghost"
              className="text-red-500 hover:text-red-700"
              aria-label={`Delete ${r.code}`}
              onClick={(e) => handleDelete(r, e)}
              disabled={busy}
            >
              Delete
            </Btn>
          )),
        ]}
        rows={rows}
        rowProps={(r) => ({
          tabIndex: 0,
          role: 'button',
          className: 'cursor-pointer',
          onClick: () => navigate(`/admin/salesmen/${r.id}?from=${from}&to=${to}`, { state: adminOriginState('/admin/salesmen') }),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/admin/salesmen/${r.id}?from=${from}&to=${to}`, { state: adminOriginState('/admin/salesmen') }); } },
        })}
        footer={(
          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1 rounded-xl border border-line bg-paper/70 px-3.5 py-2.5">
            <span className="text-[12.5px] font-medium">Total · {totals.bills} bills</span>
            <span className="text-right text-[12.5px]">
              <span className="text-ink-faint">expected </span><span className="num font-medium"><Money value={totals.expected} /></span>
              <span className="ml-3 text-ink-faint">collected </span><span className="num font-medium"><Money value={totals.collected} /></span>
              <span className="ml-3"><Variance value={totals.variance} /></span>
            </span>
          </div>
        )}
      />

      <p className="mt-2 text-[12px] text-ink-faint">
        Click a row to open that salesman's bills, collections, cancellations and shortages.
      </p>
    </div>
  );
}
