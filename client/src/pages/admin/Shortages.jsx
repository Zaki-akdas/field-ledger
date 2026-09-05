import { useMemo } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useRange, SalesmanFilter } from '../../components/AdminLayout.jsx';
import { money, dateLabel } from '../../lib/format.js';
import { Card, ErrorNote, Loading, Money, ResponsiveTable, SectionTitle, col } from '../../components/ui.jsx';

export default function Shortages() {
  useTitle('Shortages');
  const { from, to, salesmanId, setSalesman } = useRange();
  const { data, loading, error } = useApi(`/admin/shortages?from=${from}&to=${to}${salesmanId ? `&salesmanId=${salesmanId}` : ''}`);
  const people = useApi('/salesmen');

  const byProduct = useMemo(() => {
    const map = new Map();
    for (const s of data?.shortages || []) {
      const cur = map.get(s.product) || { qty: 0, amount: 0 };
      map.set(s.product, { qty: cur.qty + s.qty, amount: cur.amount + s.amount });
    }
    return [...map.entries()].sort((a, b) => b[1].amount - a[1].amount).slice(0, 12);
  }, [data]);

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
        <p className="text-[13px] text-ink-soft">
          <span className="num font-medium">{(data?.shortages || []).length}</span> short lines ·{' '}
          <span className="num font-medium text-attention">₹{money(data?.total || 0)}</span> deducted from expected collection
        </p>
        <SalesmanFilter salesmen={people.data?.salesmen} value={salesmanId} onChange={setSalesman} />
      </div>

      {loading ? <Loading label="Loading shortages…" /> : error ? <ErrorNote>{error.message}</ErrorNote> : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <ResponsiveTable
            className="max-h-[70vh] overflow-y-auto"
            cols={[
              col('Invoice', (s) => s.invoice_no, null, 'top'),
              col('Product', (s) => s.product, null, 'mid'),
              col('Reason', (s) => s.reason, null, 'mid'),
              col('Amount', (s) => <Money value={s.amount} />, 'right', 'grid'),
              col('Qty', (s) => s.qty, 'right', 'grid'),
              col('Date', (s) => dateLabel(s.short_date)),
              col('Shop', (s) => s.shop_name),
              col('Rate', (s) => <Money value={s.rate} paise />),
              col('Salesman', (s) => <span className="num">{s.salesman_code}</span>),
            ]}
            rows={data.shortages || []}
            empty={<p className="py-10 text-center text-ink-faint">No shortages reported in this period.</p>}
          />

          <div>
            <SectionTitle hint="Most-short products">By product</SectionTitle>
            <Card className="divide-y divide-line">
              {byProduct.length === 0 && <p className="px-3.5 py-5 text-[13.5px] text-ink-faint">Nothing to show.</p>}
              {byProduct.map(([product, v]) => (
                <div key={product} className="flex items-start justify-between gap-3 px-3.5 py-2.5">
                  <span className="text-[13px] text-ink">{product}</span>
                  <span className="shrink-0 text-right">
                    <span className="num block text-[13.5px]"><Money value={v.amount} /></span>
                    <span className="num text-[11.5px] text-ink-faint">{v.qty} units</span>
                  </span>
                </div>
              ))}
            </Card>
            <p className="mt-2 text-[12px] text-ink-faint">
              Shortages reduce what the salesman is expected to collect — they are not a loss line.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
