import { useMemo } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useRange, SalesmanFilter } from '../../components/AdminLayout.jsx';
import { money, dateLabel } from '../../lib/format.js';
import { Card, ErrorNote, Loading, Money, SectionTitle, TableWrap, Td, Th } from '../../components/ui.jsx';

export default function Cancellations() {
  useTitle('Cancellations');
  const { from, to, salesmanId, setSalesman } = useRange();
  const { data, loading, error } = useApi(`/admin/cancellations?from=${from}&to=${to}${salesmanId ? `&salesmanId=${salesmanId}` : ''}`);
  const people = useApi('/salesmen');

  const byReason = useMemo(() => {
    const map = new Map();
    for (const c of data?.cancellations || []) {
      const cur = map.get(c.reason) || { count: 0, amount: 0 };
      map.set(c.reason, { count: cur.count + 1, amount: cur.amount + c.amount });
    }
    return [...map.entries()].sort((a, b) => b[1].amount - a[1].amount);
  }, [data]);

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
        <p className="text-[13px] text-ink-soft">
          <span className="num font-medium">{(data?.cancellations || []).length}</span> bills cancelled ·{' '}
          <span className="num font-medium text-attention">₹{money(data?.total || 0)}</span> off the book
        </p>
        <SalesmanFilter salesmen={people.data?.salesmen} value={salesmanId} onChange={setSalesman} />
      </div>

      {loading ? <Loading label="Loading cancellations…" /> : error ? <ErrorNote>{error.message}</ErrorNote> : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <TableWrap className="max-h-[70vh] overflow-y-auto">
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Invoice</Th>
                <Th className="hidden lg:table-cell">Shop</Th>
                <Th className="hidden lg:table-cell">Salesman</Th>
                <Th align="right">Amount</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {(data.cancellations || []).map((c) => (
                <tr key={c.id}>
                  <Td className="num whitespace-nowrap text-ink-soft">{dateLabel(c.cancel_date)}</Td>
                  <Td className="num whitespace-nowrap">{c.invoice_no}</Td>
                  <Td className="hidden max-w-[220px] truncate lg:table-cell">{c.shop_name}</Td>
                  <Td className="hidden whitespace-nowrap text-[13px] lg:table-cell">
                    <span className="num text-ink-faint">{c.salesman_code}</span> {c.salesman_name}
                  </Td>
                  <Td align="right" className="num text-attention"><Money value={c.amount} /></Td>
                  <Td className="text-ink-soft max-w-[260px]">{c.reason}</Td>
                </tr>
              ))}
              {(data.cancellations || []).length === 0 && (
                <tr><Td colSpan={6} className="py-10 text-center text-ink-faint">Nothing was cancelled in this period.</Td></tr>
              )}
            </tbody>
          </TableWrap>

          <div>
            <SectionTitle hint="Where the money went">By reason</SectionTitle>
            <Card className="divide-y divide-line">
              {byReason.length === 0 && <p className="px-3.5 py-5 text-[13.5px] text-ink-faint">Nothing to show.</p>}
              {byReason.map(([reason, v]) => (
                <div key={reason} className="flex items-start justify-between gap-3 px-3.5 py-2.5">
                  <span className="text-[13px] text-ink">{reason}</span>
                  <span className="shrink-0 text-right">
                    <span className="num block text-[13.5px]"><Money value={v.amount} /></span>
                    <span className="num text-[11.5px] text-ink-faint">{v.count} {v.count === 1 ? 'bill' : 'bills'}</span>
                  </span>
                </div>
              ))}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
