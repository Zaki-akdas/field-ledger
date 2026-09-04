import { Link, useNavigate } from 'react-router-dom';
import { adminOriginState } from '../../lib/adminBack.js';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useRange } from '../../components/AdminLayout.jsx';
import { money, MODE_LABEL, dayLabel, dateLabel } from '../../lib/format.js';
import {
  Btn, Card, ErrorNote, Loading, Money, SectionTitle, TableWrap, Td, Th, Variance, cx,
} from '../../components/ui.jsx';

function Hero({ label, value, tone = 'ink', sub, subTone = 'text-ink-faint' }) {
  return (
    <div className="flex-1 min-w-0 border-b border-line px-4 py-3.5 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0 sm:px-5 sm:py-4 sm:first:pl-0 lg:px-7">
      <p className="text-[11.5px] font-medium uppercase tracking-[0.12em] text-ink-faint">{label}</p>
      <p className={cx('num mt-1.5 text-[28px] leading-none font-medium sm:text-[34px]', tone)}>{value}</p>
      <p className={cx('num mt-2 text-[11.5px] leading-relaxed sm:text-[12px]', subTone)}>{sub}</p>
    </div>
  );
}

export default function Reconciliation() {
  useTitle('Reconciliation');
  const { from, to, salesmanId } = useRange();
  const navigate = useNavigate();
  const { data, loading, error } = useApi(`/admin/reconciliation?from=${from}&to=${to}${salesmanId ? `&salesmanId=${salesmanId}` : ''}`);
  const salesmen = useApi('/salesmen');

  if (loading) return <Loading label="Reconciling…" />;
  if (error) return <ErrorNote>{error.message}</ErrorNote>;
  const r = data;

  const settledPct = r.expected > 0 ? Math.round((r.actual / r.expected) * 100) : 100;

  return (
    <div className="space-y-6">
      {/* The product's value, stated outright. */}
      <Card className="overflow-hidden">
        <div className="flex flex-col sm:flex-row">
          <Hero
            label="Expected"
            value={<Money value={r.expected} />}
            sub={`Billed ${money(r.billed)} − cancelled ${money(r.cancelled_amount)} − short ${money(r.short_amount)}`}
          />
          <Hero
            label="Collected"
            value={<Money value={r.actual} />}
            tone="text-settled"
            sub={`Cash ${money(r.by_mode.cash)} · online ${money(r.by_mode.online)} · cheque ${money(r.by_mode.cheque)} · CN ${money(r.by_mode.credit_note)}`}
            subTone="text-ink-soft"
          />
          <Hero
            label="Variance"
            value={<Variance value={r.variance} />}
            tone={Math.abs(r.variance) < 1 ? 'text-settled' : 'text-attention'}
            sub={Math.abs(r.variance) < 1
              ? 'Every rupee on the book is accounted for'
              : r.variance > 0
                ? `${settledPct}% of the book is in — the rest is still on the road`
                : 'Collected more than expected — check the entries'}
          />
        </div>
        <div className="flex flex-col gap-2 border-t border-line bg-paper/60 px-4 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 sm:px-5 lg:px-7">
          <p className="text-[12.5px] text-ink-soft">
            <span className="num font-medium">{r.bill_count}</span> bills ·{' '}
            <span className="num font-medium">{r.cancelled_count}</span> cancelled ·{' '}
            {from === to ? dateLabel(from) : `${dateLabel(from)} → ${dateLabel(to)}`}
          </p>
          <div className="flex gap-3 text-[12.5px]">
            <Link to="/admin/cash" className="font-medium text-ink underline underline-offset-4">Cash denominations</Link>
            <Link to="/admin/salesmen" className="font-medium text-ink underline underline-offset-4">Per salesman</Link>
          </div>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <SectionTitle hint="How the money came in">Collected by mode</SectionTitle>
          <TableWrap>
            <thead>
              <tr>
                <Th>Mode</Th>
                <Th align="right">Entries</Th>
                <Th align="right">Amount</Th>
                <Th align="right">Share</Th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(r.by_mode).map(([mode, amount]) => (
                <tr key={mode}>
                  <Td>{MODE_LABEL[mode]}</Td>
                  <Td align="right" className="num text-ink-soft">
                    {r.mode_entries.find((m) => m.mode === mode)?.entries || 0}
                  </Td>
                  <Td align="right" className="num"><Money value={amount} /></Td>
                  <Td align="right" className="num text-ink-faint">
                    {r.actual > 0 ? `${Math.round((amount / r.actual) * 100)}%` : '—'}
                  </Td>
                </tr>
              ))}
              <tr className="bg-paper/60">
                <Td className="font-medium">Total</Td>
                <Td />
                <Td align="right" className="num font-medium"><Money value={r.actual} /></Td>
                <Td />
              </tr>
            </tbody>
          </TableWrap>
        </div>

        <div>
          <SectionTitle hint="One row per day — where the variance sits">Day by day</SectionTitle>
          <TableWrap className="max-h-[330px] overflow-y-auto">
            <thead>
              <tr>
                <Th>Day</Th>
                <Th align="right">Bills</Th>
                <Th align="right">Expected</Th>
                <Th align="right">Collected</Th>
                <Th align="right">Variance</Th>
              </tr>
            </thead>
            <tbody>
              {[...r.days].reverse().map((d) => (
                <tr key={d.date}>
                  <Td className="whitespace-nowrap">{dayLabel(d.date)}</Td>
                  <Td align="right" className="num text-ink-soft">{d.bill_count}</Td>
                  <Td align="right" className="num"><Money value={d.expected} /></Td>
                  <Td align="right" className="num"><Money value={d.actual} /></Td>
                  <Td align="right"><Variance value={d.variance} /></Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      </div>

      <div>
        <SectionTitle
          hint={salesmanId ? 'Filtered to one salesman' : 'Everyone on the route'}
          right={<Link to="/admin/salesmen"><Btn size="sm">Open salesman drill-down</Btn></Link>}
        >
          Salesman-wise
        </SectionTitle>
        <TableWrap>
          <thead>
            <tr>
              <Th>Salesman</Th>
              <Th align="right" className="hidden md:table-cell">Bills</Th>
              <Th align="right">Expected</Th>
              <Th align="right" className="hidden xl:table-cell">Cash</Th>
              <Th align="right">Collected</Th>
              <Th align="right">Variance</Th>
              <Th className="hidden xl:table-cell">Day</Th>
            </tr>
          </thead>
          <tbody>
            {(salesmen.data?.salesmen || []).length === 0 && (
              <tr><Td colSpan={7} className="text-center text-ink-faint">No salesmen yet.</Td></tr>
            )}
            {(salesmen.data?.salesmen || []).map((s) => {
              const row = (data.salesmen || []).find((x) => x.id === s.id);
              return (
                <tr
                  key={s.id}
                  className="cursor-pointer"
                  tabIndex={0}
                  role="button"
                  onClick={() => navigate(`/admin/salesmen/${s.id}?from=${from}&to=${to}`, { state: adminOriginState('/admin') })}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/admin/salesmen/${s.id}?from=${from}&to=${to}`, { state: adminOriginState('/admin') }); } }}
                >
                  <Td>
                    <span className="num text-[12.5px] text-ink-faint">{s.code}</span>
                    <span className="block text-[13.5px] font-medium">{s.name}</span>
                  </Td>
                  <Td align="right" className="num hidden text-ink-soft md:table-cell">{row?.bill_count ?? '—'}</Td>
                  <Td align="right" className="num">{row ? <Money value={row.expected} /> : '—'}</Td>
                  <Td align="right" className="num hidden text-ink-soft xl:table-cell">{row ? <Money value={row.by_mode?.cash} /> : '—'}</Td>
                  <Td align="right" className="num">{row ? <Money value={row.collected} /> : '—'}</Td>
                  <Td align="right">{row ? <Variance value={row.variance} /> : '—'}</Td>
                  <Td className="hidden whitespace-nowrap text-[12.5px] text-ink-faint xl:table-cell">
                    {row?.day_ended ? `Ended ${row.day_ended}` : row?.day_started ? `Started ${row.day_started}` : 'Not started'}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
        <p className="mt-2 text-[12px] text-ink-faint">
          Reconciliation is measured on bills dated in the period, whatever day the cash came in.
        </p>
      </div>
    </div>
  );
}
