import { Link, useNavigate } from 'react-router-dom';
import { adminOriginState } from '../../lib/adminBack.js';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useRange } from '../../components/AdminLayout.jsx';
import { money, MODE_LABEL, dayLabel, dateLabel } from '../../lib/format.js';
import {
  Card, ErrorNote, Loading, Money, ResponsiveTable, SectionTitle, Variance, col, cx,
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
            sub={`Billed ${money(r.billed)} · cancelled ${money(r.cancelled_amount)} · short ${money(r.short_amount)}`}
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
        {/* Grid alignment (usability audit #4): this strip sits under the
            three-column hero above, so its content mirrors that rhythm —
            metadata spans the first two columns, the drill-down links land
            in the third, where the Variance figure they explain sits. */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-1 border-t border-line bg-paper/60 px-4 py-2.5 sm:grid-cols-3 sm:px-5 lg:px-7">
          <p className="text-[12.5px] text-ink-soft sm:col-span-2">
            <span className="num font-medium">{r.bill_count}</span> bills ·{' '}
            <span className="num font-medium">{r.cancelled_count}</span> cancelled ·{' '}
            {from === to ? dateLabel(from) : `${dateLabel(from)} → ${dateLabel(to)}`}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] sm:justify-end">
            <Link to="/admin/cash" className="font-medium text-ink underline underline-offset-4">Cash denominations</Link>
            <Link to="/admin/salesmen" className="font-medium text-ink underline underline-offset-4">Per salesman</Link>
          </div>
        </div>
      </Card>        {/* Equal columns: the mode and day tables have similar density, so a
          50/50 split reads balanced — the earlier 1fr/300px split starved the
          day table and left dead whitespace mid-page (usability audit #4). */}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="min-w-0">
          <SectionTitle hint="How the money came in">Collected by mode</SectionTitle>
          <ResponsiveTable
            cols={[
              col('Mode', (m) => MODE_LABEL[m.mode], null, 'top'),
              col('Entries', (m) => m.entries, 'right'),
              col('Amount', (m) => <Money value={m.amount} />, 'right', 'grid'),
              col('Share', (m) => (r.actual > 0 ? `${Math.round((m.amount / r.actual) * 100)}%` : '—'), 'right'),
            ]}
            rows={Object.entries(r.by_mode).map(([mode, amount]) => ({
              key: mode,
              mode,
              amount,
              entries: r.mode_entries.find((x) => x.mode === mode)?.entries || 0,
            }))}
            footer={
              // A real footer row (usability audit #7): the total sits directly
              // under the Amount column it sums, aligned with the data above,
              // not as a pill-shaped div that read as a clickable button.
              <div className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-x-3 rounded-xl border border-line bg-paper/60 px-3.5 py-2">
                <span className="text-[12px] font-medium uppercase tracking-wider text-ink-faint">Total</span>
                <span className="num text-right text-[13.5px] font-medium">{Object.values(r.by_mode).reduce((a, b) => a + b, 0).toLocaleString('en-IN')} entries</span>
                <span className="num text-right text-[13.5px] font-medium"><Money value={r.actual} /></span>
                <span className="text-right text-[12.5px] text-ink-faint">100%</span>
              </div>
            }
          />
        </div>

        <div className="min-w-0">
          <SectionTitle hint="One row per day — where the variance sits">Day by day</SectionTitle>
          <ResponsiveTable
            className="max-h-[70vh] overflow-y-auto"
            tableWrapProps={{ className: 'max-h-[330px] overflow-y-auto' }}
            cols={[
              col('Day', (d) => dayLabel(d.date), null, 'top'),
              col('Bills', (d) => d.bill_count, 'right'),
              col('Expected', (d) => <Money value={d.expected} />, 'right', 'grid'),
              col('Collected', (d) => <Money value={d.actual} />, 'right', 'grid'),
              col('Variance', (d) => <Variance value={d.variance} />, 'right', 'grid'),
            ]}
            rows={[...r.days].reverse()}
          />
        </div>
      </div>

      <div className="mt-5 lg:col-span-2">
        <SectionTitle hint={salesmanId ? 'Filtered to one salesman' : 'Everyone on the route'}>
          Salesman-wise
        </SectionTitle>
        <ResponsiveTable
          cols={[
            col('Salesman', (s) => (
              <span>
                <span className="num text-[12.5px] text-ink-faint">{s.code}</span>
                <span className="block text-[13.5px] font-medium">{s.name}</span>
              </span>
            ), null, 'top'),
            col('Expected', (s) => (s.row ? <Money value={s.row.expected} /> : '—'), 'right', 'grid'),
            col('Collected', (s) => (s.row ? <Money value={s.row.collected} /> : '—'), 'right', 'grid'),
            col('Variance', (s) => (s.row ? <Variance value={s.row.variance} /> : '—'), 'right', 'grid'),
            col('Bills', (s) => s.row?.bill_count ?? '—', 'right'),
            col('Day', (s) => (s.row?.day_ended ? `Ended ${s.row.day_ended}` : s.row?.day_started ? `Started ${s.row.day_started}` : 'Not started')),
            // Affordance: the row opens the salesman's detail — say so on every
            // row instead of relying on cursor:pointer alone (audit #5).
            col('View', () => (
              <span aria-hidden="true" className="text-ink-faint">›</span>
            ), 'right'),
          ]}
          rows={(salesmen.data?.salesmen || []).map((s) => ({ ...s, row: (data.salesmen || []).find((x) => x.id === s.id) }))}
          empty={
            // Empty state (usability audit #11): a CTA belongs in the empty
            // region itself — the drill-down button no longer floats beside
            // the heading, far from where the user is looking.
            <div className="space-y-3">
              <p>No salesmen yet.</p>
              <p className="text-[12.5px]">
                <Link to="/admin/salesmen" className="font-medium text-ink underline underline-offset-4">
                  Open salesman drill-down →
                </Link>
              </p>
            </div>
          }
          rowProps={(s) => ({
            tabIndex: 0,
            role: 'button',
            className: 'cursor-pointer hover:bg-paper/70 focus-visible:bg-paper/70 transition-colors',
            'aria-label': `Open ${s.name}'s detail`,
            onClick: () => navigate(`/admin/salesmen/${s.id}?from=${from}&to=${to}`, { state: adminOriginState('/admin') }),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/admin/salesmen/${s.id}?from=${from}&to=${to}`, { state: adminOriginState('/admin') }); } },
          })}
        />
        <p className="mt-2 text-[12px] text-ink-faint">
          Reconciliation is measured on bills dated in the period, whatever day the cash came in.
        </p>
      </div>
    </div>
  );
}
