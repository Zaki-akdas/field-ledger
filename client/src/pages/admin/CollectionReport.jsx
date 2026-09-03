import { Fragment, useMemo } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useRange, SalesmanFilter } from '../../components/AdminLayout.jsx';
import { money, dateLabel } from '../../lib/format.js';
import { Card, ErrorNote, Loading, Money, TableWrap, Td } from '../../components/ui.jsx';

/**
 * Collection report — the office's printable daily register in the CO-SHIP
 * layout: S.No, invoice, party and amount per line, grouped by day with a
 * subtotal under each day and a grand total. Cancelled bills are excluded.
 * The header Excel/PDF buttons export the same register.
 */
export default function CollectionReport() {
  useTitle('Collection report');
  const { from, to, salesmanId, setSalesman } = useRange();
  const { data, loading, error } = useApi(`/admin/bills?from=${from}&to=${to}${salesmanId ? `&salesmanId=${salesmanId}` : ''}`);
  const people = useApi('/salesmen');

  const view = useMemo(() => {
    const src = data?.bills || [];
    const cancelled = src.filter((b) => b.status === 'cancelled').length;
    const live = src
      .filter((b) => b.status !== 'cancelled')
      .sort((a, b) => String(a.bill_date).localeCompare(String(b.bill_date))
        || String(a.invoice_no).localeCompare(String(b.invoice_no)));
    // Balance = what is still unpaid after shorts and collections, matching
    // the expected-based balance the rest of the app shows for a bill.
    const derive = (b) => {
      const collected = Math.round(Number(b.collected_amount || 0) * 100) / 100;
      const balance = Math.max(0, Math.round(((Number(b.amount || 0) - Number(b.short_amount || 0)) * 100 - collected * 100)) / 100);
      return { collected, balance };
    };
    const groups = [];
    let sno = 0;
    let billed = 0;
    let collectedAll = 0;
    let balanceAll = 0;
    for (const b of live) {
      const { collected, balance } = derive(b);
      const last = groups[groups.length - 1];
      if (!last || last.date !== b.bill_date) {
        groups.push({ date: b.bill_date, rows: [], amount: 0, collected: 0, balance: 0 });
      }
      const g = groups[groups.length - 1];
      sno += 1;
      billed += Number(b.amount || 0);
      collectedAll += collected;
      balanceAll += balance;
      g.rows.push({ ...b, sno, collected, balance });
      g.amount += Number(b.amount || 0);
      g.collected += collected;
      g.balance += balance;
    }
    return { groups, count: live.length, billed, collected: collectedAll, balance: balanceAll, cancelled };
  }, [data]);

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2">
        <SalesmanFilter salesmen={people.data?.salesmen} value={salesmanId} onChange={setSalesman} />
        <span className="text-[12.5px] text-ink-faint">
          <span className="num">{view.count}</span> bills · ₹<span className="num">{money(view.billed)}</span> billed
          {view.cancelled > 0 ? ` · ${view.cancelled} cancelled excluded` : ''}
        </span>
      </div>

      {loading ? <Loading label="Building the register…" /> : error ? <ErrorNote>{error.message}</ErrorNote> : view.count === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-[14px] font-medium">No bills in this range.</p>
          <p className="mt-1 text-[13px] text-ink-faint">Widen the date range or pick a salesman to see their register.</p>
        </Card>
      ) : (
        <TableWrap className="max-h-[70vh] overflow-y-auto">
          <thead>
            <tr>
              <th className="w-14">S.No</th>
              <th>Invoice</th>
              <th>Party</th>
              <th className="text-right">Amount</th>
              <th className="text-right">Collected</th>
              <th className="text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
              {view.groups.map((g) => (
                <Fragment key={g.date}>
                  <tr className="bg-surface">
                    <td colSpan={6} className="!py-2 text-[12px] font-semibold uppercase tracking-wider text-ink-soft">
                      {dateLabel(g.date)} · {g.rows.length} {g.rows.length === 1 ? 'bill' : 'bills'}
                    </td>
                  </tr>
                  {g.rows.map((b) => (
                    <tr key={b.id}>
                      <Td className="num text-ink-faint">{b.sno}</Td>
                      <Td className="num whitespace-nowrap">{b.invoice_no}</Td>
                      <Td className="max-w-[220px]">
                        <p className="truncate text-ink">{b.shop_name}</p>
                        <p className="num truncate text-[11.5px] text-ink-faint">{b.salesman_code} · {b.salesman_name}</p>
                      </Td>
                      <Td align="right" className="num"><Money value={b.amount} /></Td>
                      <Td align="right" className="num"><Money value={b.collected} /></Td>
                      <Td align="right" className="num">
                        <Money value={b.balance} className={b.balance > 0.5 ? 'text-attention font-medium' : 'text-ink-faint'} />
                      </Td>
                    </tr>
                  ))}
                  <tr className="bg-surface">
                    <td colSpan={3} className="!py-2 text-right text-[12.5px] font-semibold">Day total</td>
                    <Td align="right" className="num !py-2 font-semibold"><Money value={g.amount} /></Td>
                    <Td align="right" className="num !py-2 font-semibold"><Money value={g.collected} /></Td>
                    <Td align="right" className="num !py-2 font-semibold"><Money value={g.balance} /></Td>
                  </tr>
                </Fragment>
              ))}
              <tr className="border-t-2 border-ink bg-surface">
                <td colSpan={3} className="text-right text-[14px] font-semibold">Grand total · {view.count} bills</td>
                <Td align="right" className="num text-[14px] font-semibold"><Money value={view.billed} /></Td>
                <Td align="right" className="num text-[14px] font-semibold"><Money value={view.collected} /></Td>
                <Td align="right" className="num text-[14px] font-semibold"><Money value={view.balance} /></Td>
              </tr>
            </tbody>
        </TableWrap>
      )}
    </div>
  );
}
