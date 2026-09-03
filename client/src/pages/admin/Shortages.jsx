import { useMemo } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useRange, SalesmanFilter } from '../../components/AdminLayout.jsx';
import { money, dateLabel } from '../../lib/format.js';
import { Card, ErrorNote, Loading, Money, SectionTitle, TableWrap, Td, Th } from '../../components/ui.jsx';

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
          <TableWrap className="max-h-[70vh] overflow-y-auto">
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Invoice</Th>
                <Th className="hidden xl:table-cell">Shop</Th>
                <Th>Product</Th>
                <Th align="right">Qty</Th>
                <Th align="right" className="hidden lg:table-cell">Rate</Th>
                <Th align="right">Amount</Th>
                <Th>Reason</Th>
                <Th className="hidden lg:table-cell">Salesman</Th>
              </tr>
            </thead>
            <tbody>
              {(data.shortages || []).map((s) => (
                <tr key={s.id}>
                  <Td className="num whitespace-nowrap text-ink-soft">{dateLabel(s.short_date)}</Td>
                  <Td className="num whitespace-nowrap">{s.invoice_no}</Td>
                  <Td className="hidden max-w-[180px] truncate xl:table-cell">{s.shop_name}</Td>
                  <Td className="max-w-[200px] truncate">{s.product}</Td>
                  <Td align="right" className="num">{s.qty}</Td>
                  <Td align="right" className="num hidden text-ink-soft lg:table-cell"><Money value={s.rate} paise /></Td>
                  <Td align="right" className="num text-attention"><Money value={s.amount} /></Td>
                  <Td className="max-w-[200px] truncate text-ink-soft">{s.reason}</Td>
                  <Td className="hidden whitespace-nowrap text-[13px] lg:table-cell"><span className="num text-ink-faint">{s.salesman_code}</span></Td>
                </tr>
              ))}
              {(data.shortages || []).length === 0 && (
                <tr><Td colSpan={9} className="py-10 text-center text-ink-faint">No shortages reported in this period.</Td></tr>
              )}
            </tbody>
          </TableWrap>

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
