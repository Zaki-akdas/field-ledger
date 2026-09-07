import { useMemo, useState } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useRange, SalesmanFilter } from '../../components/AdminLayout.jsx';
import { useToast } from '../../lib/context.jsx';
import { api } from '../../lib/api.js';
import { money, dateLabel, STATUS_LABEL } from '../../lib/format.js';
import {
  Btn, Chips, ErrorNote, Input, Loading, Money, Pill, ResponsiveTable, col,
} from '../../components/ui.jsx';
import BillEditSheet from '../../components/BillEditSheet.jsx';

const TONE = { delivered: 'settled', partial: 'attention', pending: 'neutral', cancelled: 'attention' };

export default function Bills() {
  useTitle('Bills');
  const { from, to, salesmanId, setSalesman } = useRange();
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const { push } = useToast();
  const { data, loading, error, reload } = useApi(`/admin/bills?from=${from}&to=${to}${salesmanId ? `&salesmanId=${salesmanId}` : ''}`);
  const people = useApi('/salesmen');

  const onEdited = (bill, changed) => {
    setEditing(null);
    push(changed.length ? `Saved — ${changed.map((c) => c.label).join(', ')} updated, change recorded.` : 'No changes to save.', 'success');
    reload();
  };

  const bills = useMemo(() => {
    let rows = data?.bills || [];
    if (status !== 'all') rows = rows.filter((b) => b.status === status);
    if (q.trim()) {
      const n = q.toLowerCase();
      rows = rows.filter((b) => b.invoice_no.toLowerCase().includes(n)
        || b.shop_name.toLowerCase().includes(n)
        || (b.shop_area || '').toLowerCase().includes(n)
        || b.salesman_name.toLowerCase().includes(n));
    }
    return rows;
  }, [data, status, q]);

  const counts = useMemo(() => {
    const src = data?.bills || [];
    return {
      all: src.length,
      pending: src.filter((b) => b.status === 'pending').length,
      partial: src.filter((b) => b.status === 'partial').length,
      delivered: src.filter((b) => b.status === 'delivered').length,
      cancelled: src.filter((b) => b.status === 'cancelled').length,
    };
  }, [data]);

  const total = bills.reduce((a, b) => a + b.amount, 0);

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
  const handleDelete = async (bill, e) => {
    e.stopPropagation();
    if (!window.confirm(`Delete bill ${bill.invoice_no}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.del(`/admin/bills/${bill.id}`);
      push(`Deleted ${bill.invoice_no}.`, 'success');
      reload();
    } catch (err) {
      push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ---- bulk delete ---- */
  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} bill${selected.size > 1 ? 's' : ''}? Bills with collections will be skipped.`)) return;
    setBusy(true);
    try {
      const r = await api.post('/admin/bills/delete', { ids: [...selected] });
      const n = r.deleted?.length || 0;
      const skip = r.skipped?.length || 0;
      push(n ? `Deleted ${n} bill${n > 1 ? 's' : ''}${skip ? `, skipped ${skip}` : ''}.` : 'Nothing was deleted.', n ? 'success' : 'error');
      setSelected(new Set());
      reload();
    } catch (err) {
      push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search invoice, shop, salesman" className="h-11 w-full min-h-[44px] sm:max-w-[280px] sm:flex-1 sm:h-9 sm:min-h-0" aria-label="Search bills" />
        <div className="flex flex-wrap items-center gap-2">
          <SalesmanFilter salesmen={people.data?.salesmen} value={salesmanId} onChange={setSalesman} />
          <span className="text-[12.5px] text-ink-faint">
            <span className="num">{bills.length}</span> bills · ₹<span className="num">{money(total)}</span> billed
          </span>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm dark:bg-red-950/30">
          <span className="font-medium text-red-700 dark:text-red-300">{selected.size} selected</span>
          <Btn size="sm" variant="danger" onClick={handleBulkDelete} disabled={busy}>
            Delete selected
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Btn>
        </div>
      )}

      <Chips
        className="mb-3"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'all', label: 'All', count: counts.all },
          { value: 'pending', label: 'Pending', count: counts.pending },
          { value: 'partial', label: 'Part collected', count: counts.partial },
          { value: 'delivered', label: 'Delivered', count: counts.delivered },
          { value: 'cancelled', label: 'Cancelled', count: counts.cancelled },
        ]}
      />

      {loading ? <Loading label="Loading bills…" /> : error ? <ErrorNote>{error.message}</ErrorNote> : (
        <ResponsiveTable
          className="max-h-[70vh] overflow-y-auto"
          cols={[
            col('', (b) => (
              <input
                type="checkbox"
                checked={selected.has(b.id)}
                onChange={(e) => toggleSelect(b.id, e)}
                className="h-4 w-4 cursor-pointer accent-red-500"
                aria-label={`Select ${b.invoice_no}`}
              />
            ), 'center', 'grid'),
            col('Invoice', (b) => b.invoice_no, null, 'top'),
            col('Status', (b) => <Pill tone={TONE[b.status]}>{STATUS_LABEL[b.status]}</Pill>, null, 'mid'),
            col('Amount', (b) => <Money value={b.amount} />, 'right', 'grid'),
            col('Balance', (b) => <Money value={b.amount - b.short_amount - b.collected_amount} />, 'right', 'grid'),
            col('Shop', (b) => b.shop_name),
            col('Salesman', (b) => <span><span className="num text-ink-faint">{b.salesman_code}</span> {b.salesman_name}</span>),
            col('Date', (b) => dateLabel(b.bill_date)),
            col('', (b) => (
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <Btn
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit ${b.invoice_no}`}
                  onClick={(e) => { e.stopPropagation(); setEditing(b); }}
                >
                  Edit
                </Btn>
                <Btn
                  size="sm"
                  variant="ghost"
                  className="text-red-500 hover:text-red-700"
                  aria-label={`Delete ${b.invoice_no}`}
                  onClick={(e) => handleDelete(b, e)}
                  disabled={busy}
                >
                  Delete
                </Btn>
              </div>
            )),
          ]}
          rows={bills}
          rowProps={(b) => ({
            onClick: () => setEditing(b),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(b); } },
            tabIndex: 0,
            role: 'button',
            'aria-label': `Edit ${b.invoice_no}`,
            className: 'cursor-pointer',
          })}
          cardProps={(b) => ({ onClick: () => setEditing(b), role: 'button', tabIndex: 0, 'aria-label': `Edit ${b.invoice_no}`, className: 'cursor-pointer anim-press' })}
          empty={<p className="py-10 text-center text-ink-faint">No bills match these filters.</p>}
        />
      )}

      <BillEditSheet bill={editing} onClose={() => setEditing(null)} onSaved={onEdited} />
    </div>
  );
}
