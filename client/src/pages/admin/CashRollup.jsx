import { useApi, useTitle } from '../../lib/hooks.js';
import { useRange, SalesmanFilter } from '../../components/AdminLayout.jsx';
import { money } from '../../lib/format.js';
import { Card, ErrorNote, Loading, Money, ResponsiveTable, SectionTitle, col } from '../../components/ui.jsx';

export default function CashRollup() {
  useTitle('Cash rollup');
  const { from, to, salesmanId, setSalesman } = useRange();
  const { data, loading, error } = useApi(`/admin/cash-rollup?from=${from}&to=${to}${salesmanId ? `&salesmanId=${salesmanId}` : ''}`);
  const people = useApi('/salesmen');

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
        <p className="text-[13px] text-ink-soft">
          Notes and coins collected between <span className="num">{from}</span> and <span className="num">{to}</span> — for planning the bank deposit.
        </p>
        <SalesmanFilter salesmen={people.data?.salesmen} value={salesmanId} onChange={setSalesman} />
      </div>

      {loading ? <Loading label="Counting notes…" /> : error ? <ErrorNote>{error.message}</ErrorNote> : (
        <div className="grid gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
          <div>
            <SectionTitle hint={`₹${money(data.total)} in cash`}>Denominations</SectionTitle>
            <ResponsiveTable
              cols={[
                col('Denomination', (d) => <span className="num text-[13.5px] font-medium">₹{d.denom}</span>, null, 'top'),
                col('Count', (d) => d.count.toLocaleString('en-IN'), 'right', 'grid'),
                col('Amount', (d) => <Money value={d.amount} />, 'right', 'grid'),
              ]}
              rows={data.rows}
              empty={<p className="py-8 text-center text-ink-faint">No cash collected in this period.</p>}
              footer={(
                <div className="flex items-center justify-between rounded-xl border border-line bg-paper/70 px-3.5 py-2.5">
                  <span className="text-[12.5px] font-medium">Total</span>
                  <span className="num text-[13px] font-medium">
                    {data.rows.reduce((a, r) => a + r.count, 0).toLocaleString('en-IN')} notes · <Money value={data.total} />
                  </span>
                </div>
              )}
            />
            <p className="mt-2 text-[12px] text-ink-faint">
              This counts cash by the day it was collected, unlike the reconciliation strip which follows bill dates.
            </p>
          </div>

          <div>
            <SectionTitle hint="What to hand over">Deposit sheet</SectionTitle>
            <Card className="p-5">
              <p className="text-[11.5px] uppercase tracking-wider text-ink-faint">Cash in hand</p>
              <p className="num mt-1 text-[36px] leading-none font-medium">₹{money(data.total)}</p>
              <div className="mt-5 space-y-2 border-t border-line pt-4">
                {data.rows.filter((r) => r.count > 0).slice(0, 10).map((r) => (
                  <div key={r.denom} className="flex items-center gap-3">
                    <span className="num w-16 text-[13px] text-ink-soft">₹{r.denom}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-settled"
                        style={{ width: `${Math.round((r.amount / (data.total || 1)) * 100)}%` }}
                      />
                    </div>
                    <span className="num w-20 shrink-0 text-right text-[12px] sm:w-24 sm:text-[13px]">{r.count.toLocaleString('en-IN')}</span>
                  </div>
                ))}
              </div>
              <p className="mt-5 text-[12.5px] text-ink-faint">
                Bundle notes of ₹50 and above in packs of 100 for the deposit slip.
              </p>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
