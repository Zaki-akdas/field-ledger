import { useMemo, useState } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useRange, SalesmanFilter } from '../../components/AdminLayout.jsx';
import { money, dateLabel, STATUS_LABEL } from '../../lib/format.js';
import {
  Chips, ErrorNote, Input, Loading, Money, Pill, TableWrap, Td, Th,
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
        <TableWrap className="max-h-[70vh] overflow-y-auto">
          <thead>
            <tr>
              <Th>Invoice</Th>
              <Th className="hidden lg:table-cell">Date</Th>
              <Th>Shop</Th>
              <Th className="hidden lg:table-cell">Salesman</Th>
              <Th align="right">Amount</Th>
              <Th align="right" className="hidden xl:table-cell">Short</Th>
              <Th align="right" className="hidden md:table-cell">Collected</Th>
              <Th align="right">Balance</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.id}>
                <Td className="num whitespace-nowrap">{b.invoice_no}</Td>
                <Td className="num hidden whitespace-nowrap text-ink-soft lg:table-cell">{dateLabel(b.bill_date)}</Td>
                <Td className="max-w-[220px] truncate">{b.shop_name}{b.shop_area ? <span className="text-ink-faint"> · {b.shop_area}</span> : null}</Td>
                <Td className="hidden whitespace-nowrap text-[13px] lg:table-cell"><span className="num text-ink-faint">{b.salesman_code}</span> {b.salesman_name}</Td>
                <Td align="right" className="num"><Money value={b.amount} /></Td>
                <Td align="right" className="num hidden xl:table-cell">{b.short_amount > 0 ? <span className="text-attention"><Money value={b.short_amount} /></span> : <span className="text-ink-faint">—</span>}</Td>
                <Td align="right" className="num hidden md:table-cell"><Money value={b.collected_amount} /></Td>
                <Td align="right" className="num"><Money value={b.amount - b.short_amount - b.collected_amount} /></Td>
                <Td><Pill tone={TONE[b.status]}>{STATUS_LABEL[b.status]}</Pill></Td>
              </tr>
            ))}
            {bills.length === 0 && (
              <tr><Td colSpan={9} className="py-10 text-center text-ink-faint">No bills match these filters.</Td></tr>
            )}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
