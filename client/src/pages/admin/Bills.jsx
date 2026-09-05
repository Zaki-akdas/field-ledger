import { useMemo, useState } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useRange, SalesmanFilter } from '../../components/AdminLayout.jsx';
import { money, dateLabel, STATUS_LABEL } from '../../lib/format.js';
import {
  Chips, ErrorNote, Input, Loading, Money, Pill, ResponsiveTable, col,
} from '../../components/ui.jsx';

const TONE = { delivered: 'settled', partial: 'attention', pending: 'neutral', cancelled: 'attention' };

export default function Bills() {
  useTitle('Bills');
  const { from, to, salesmanId, setSalesman } = useRange();
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const { data, loading, error } = useApi(`/admin/bills?from=${from}&to=${to}${salesmanId ? `&salesmanId=${salesmanId}` : ''}`);
  const people = useApi('/salesmen');

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
            col('Invoice', (b) => b.invoice_no, null, 'top'),
            col('Status', (b) => <Pill tone={TONE[b.status]}>{STATUS_LABEL[b.status]}</Pill>, null, 'mid'),
            col('Amount', (b) => <Money value={b.amount} />, 'right', 'grid'),
            col('Balance', (b) => <Money value={b.amount - b.short_amount - b.collected_amount} />, 'right', 'grid'),
            col('Shop', (b) => b.shop_name),
            col('Salesman', (b) => <span><span className="num text-ink-faint">{b.salesman_code}</span> {b.salesman_name}</span>),
            col('Date', (b) => dateLabel(b.bill_date)),
          ]}
          rows={bills}
          empty={<p className="py-10 text-center text-ink-faint">No bills match these filters.</p>}
        />
      )}
    </div>
  );
}
