import { useMemo } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useRange, SalesmanFilter } from '../../components/AdminLayout.jsx';
import { money, dateLabel } from '../../lib/format.js';
import { Card, ErrorNote, Loading, Money, ResponsiveTable, SectionTitle, col } from '../../components/ui.jsx';

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
          <ResponsiveTable
            className="max-h-[70vh] overflow-y-auto"
            cols={[
              col('Invoice', (c) => c.invoice_no, null, 'top'),
              col('Reason', (c) => c.reason, null, 'mid'),
              col('Amount', (c) => <Money value={c.amount} />, 'right', 'grid'),
              col('Date', (c) => dateLabel(c.cancel_date)),
              col('Shop', (c) => c.shop_name),
              col('Salesman', (c) => <span><span className="num text-ink-faint">{c.salesman_code}</span> {c.salesman_name}</span>),
            ]}
            rows={data.cancellations || []}
            empty={<p className="py-10 text-center text-ink-faint">Nothing was cancelled in this period.</p>}
          />

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
