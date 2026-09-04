import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useApi, useTitle, useDarkMode } from '../../lib/hooks.js';
import { useAuth, useSync } from '../../lib/context.jsx';
import { todayISO, shiftISO, MODE_LABEL, rupees, dateLabel } from '../../lib/format.js';
import { withBack } from '../../lib/fieldBack.js';
import {
  Btn, Card, ErrorNote, Loading, SectionTitle, Segmented, Variance,
} from '../../components/ui.jsx';
import StepRail from '../../components/StepRail.jsx';
import { QueuedList } from '../../components/FieldLayout.jsx';

const RANGES = [
  { value: '0', label: 'Today' },
  { value: '6', label: '7 days' },
  { value: '29', label: '30 days' },
];

const STEPS = [
  { label: 'Start day', to: '/field/start' },
  { label: 'Visit shop', to: '/field/bills' },
  { label: 'Collect', to: '/field/collect' },
  { label: 'End day', to: '/field/end' },
];

function Stat({ label, value, tone = '', hint }) {
  return (
    <div className="panel p-3.5">
      <p className="text-[11.5px] font-medium uppercase tracking-wider text-ink-faint">{label}</p>
      <p className={`num mt-1 text-[19px] leading-none font-medium ${tone}`}>{value}</p>
      {hint && <p className="mt-1 text-[11.5px] text-ink-faint">{hint}</p>}
    </div>
  );
}

export default function Me() {
  useTitle('My numbers');
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Where the running-total header was tapped from; only known tabs are honored
  // so a hand-edited ?back= can't forge a label or destination.
  const backTo = new URLSearchParams(location.search).get('back');
  const backLabel = backTo === '/field/bills' ? 'Bills' : backTo === '/field/collect' ? 'Collect' : null;
  const { dark, toggle: toggleDark } = useDarkMode();
  const [days, setDays] = useState('0');
  const today = todayISO();
  const from = shiftISO(today, -Number(days));
  const { data, loading, error } = useApi(`/me/dashboard?from=${from}&to=${today}`);

  // Full bill list for the same range — drives the overall summary card and
  // the bill-wise statement (invoice rows + grand total, report style).
  const billsRes = useApi(`/bills?from=${from}&to=${today}`);
  const billRows = useMemo(
    () => (billsRes.data?.bills || []).filter((b) => b.status !== 'cancelled'),
    [billsRes.data],
  );
  const summary = useMemo(() => {
    const open = billRows.filter((b) => b.status === 'pending' || b.status === 'partial');
    return {
      count: billRows.length,
      billed: billRows.reduce((a, b) => a + Number(b.amount || 0), 0),
      collected: billRows.reduce((a, b) => a + Number(b.collected_amount || 0), 0),
      outstanding: open.reduce((a, b) => a + Number(b.balance || 0), 0),
      open: open.length,
      cancelled: (billsRes.data?.bills || []).filter((b) => b.status === 'cancelled').length,
    };
  }, [billRows, billsRes.data]);

  const rangeLabel = (RANGES.find((r) => r.value === days) || {}).label.toLowerCase();
  const periodLabel = days === '0' ? dateLabel(today) : `${dateLabel(from)} – ${dateLabel(today)}`;
  const session = useApi('/session/today');
  const { online, queue } = useSync();
  const { logout } = useAuth();

  const started = Boolean(session.data?.session?.started_at);
  const ended = Boolean(session.data?.session?.ended_at);
  const closed = (data?.bills?.delivered || 0) + (data?.bills?.cancelled || 0);
  const step = ended ? 5 : started ? (closed > 0 ? 3 : 2) : 1;

  return (
    <div className="pb-6">
      {backLabel && backTo && (
        <Link
          to={backTo}
          replace
          aria-label={`Back to ${backLabel}`}
          className="mb-3 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] font-medium text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink active:opacity-70"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to {backLabel}
        </Link>
      )}
      <div className="mb-4">
        <h1 className="text-[22px] font-semibold tracking-tight">{user?.name}</h1>
        <p className="num text-[13px] text-ink-soft">{user?.code} · {user?.phone}</p>
      </div>

      <StepRail steps={STEPS} current={step} onStep={(to) => navigate(to)} className="mb-5" />

      <Segmented className="mb-4" value={days} onChange={setDays} options={RANGES} />

      {loading || billsRes.loading ? <Loading label="Adding up…" /> : (error || billsRes.error) ? (
        <ErrorNote>{(error || billsRes.error).message}</ErrorNote>
      ) : data && (
        <>
          <Card className="p-4">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-[11.5px] uppercase tracking-wider text-ink-faint">Collected</p>
                <p className="num text-[30px] leading-none font-medium">{rupees(data.collected)}</p>
              </div>
              <div className="text-right">
                <p className="text-[11.5px] uppercase tracking-wider text-ink-faint">Expected</p>
                <p className="num text-[15px] text-ink-soft">{rupees(data.expected)}</p>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
              <span className="text-[13px] text-ink-soft">Variance</span>
              <Variance value={data.variance} className="text-[17px] font-medium" />
            </div>
          </Card>

          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:gap-3">
            <Stat label="Delivered" value={data.bills.delivered} hint={`${data.bill_count} bills on the book`} />
            <Stat label="Pending" value={data.pending.count} tone={data.pending.count ? 'text-attention' : ''} hint={`${rupees(data.pending.amount)} outstanding`} />
            <Stat label="Cancelled" value={data.cancelled.count} tone={data.cancelled.count ? 'text-attention' : ''} hint={`${rupees(data.cancelled.amount)} off the book`} />
            <Stat label="Short items" value={rupees(data.short.amount)} tone={data.short.amount ? 'text-attention' : ''} hint={`${data.short.count} ${data.short.count === 1 ? 'line' : 'lines'}`} />
          </div>

          {/* Overall billed / collected / outstanding for the range — the same
              summary card shown above the bills list, so “My numbers” reads like
              the printed CO-SHIP collection report. */}
          <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-2.5" aria-label={`${rangeLabel} summary`}>
            <div className="rounded-xl border border-line bg-surface px-3 py-2.5 sm:px-3.5 sm:py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint sm:text-[10.5px]">
                {days === '0' ? "Today's billed" : 'Billed'}
              </p>
              <p className="num mt-1 text-[17px] leading-none font-semibold sm:text-[19px]">{rupees(summary.billed)}</p>
              <p className="num mt-1.5 text-[10.5px] leading-tight text-ink-faint sm:text-[11.5px]">
                {summary.count} {summary.count === 1 ? 'bill' : 'bills'}{summary.cancelled ? ` · ${summary.cancelled} cancelled` : ''}
              </p>
            </div>
            <div className="rounded-xl border border-line bg-surface px-3 py-2.5 sm:px-3.5 sm:py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint sm:text-[10.5px]">Collected</p>
              <p className={`num mt-1 text-[17px] leading-none font-semibold sm:text-[19px] ${summary.collected > 0 ? 'text-settled' : ''}`}>
                {rupees(summary.collected)}
              </p>
              <p className="num mt-1.5 text-[10.5px] leading-tight text-ink-faint sm:text-[11.5px]">{rangeLabel}</p>
            </div>
            <div className="rounded-xl border border-line bg-surface px-3 py-2.5 sm:px-3.5 sm:py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint sm:text-[10.5px]">Outstanding</p>
              <p className={`num mt-1 text-[17px] leading-none font-semibold sm:text-[19px] ${summary.outstanding > 0.5 ? 'text-attention' : ''}`}>
                {rupees(summary.outstanding)}
              </p>
              <p className="num mt-1.5 text-[10.5px] leading-tight text-ink-faint sm:text-[11.5px]">
                {summary.open} open{summary.outstanding <= 0.5 ? ' · all closed' : ''}
              </p>
            </div>
          </div>

          {/* Bill-wise statement: S.No / invoice / party / amount + grand total. */}
          <div className="mt-4 sm:mt-5">
            <SectionTitle hint={`${periodLabel} · ${summary.count} ${summary.count === 1 ? 'bill' : 'bills'}`}>
              Bill-wise
            </SectionTitle>
            {billRows.length === 0 ? (
              <Card className="p-5 text-center">
                <p className="text-[14px] font-medium">No bills in this period.</p>
                <p className="mt-1 text-[13px] text-ink-faint">Upload a batch from “Add bills” to see the invoice-wise statement here.</p>
              </Card>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-line bg-surface">
                <table className="w-full min-w-[440px] text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-faint">
                      <th className="w-12 py-2.5 pl-3.5 pr-2 font-semibold">S.No</th>
                      <th className="py-2.5 px-2 font-semibold">Invoice</th>
                      <th className="py-2.5 px-2 font-semibold">Party</th>
                      <th className="py-2.5 pl-2 pr-3.5 text-right font-semibold">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {billRows.map((b, i) => (
                      <tr key={b.id}>
                        <td className="num py-2.5 pl-3.5 pr-2 text-ink-faint">{i + 1}</td>
                        <td className="num whitespace-nowrap py-2.5 px-2">{b.invoice_no}</td>
                        <td className="max-w-[160px] truncate py-2.5 px-2">{b.shop_name}</td>
                        <td className="num whitespace-nowrap py-2.5 pl-2 pr-3.5 text-right">{rupees(b.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-line bg-surface">
                      <td colSpan={3} className="py-2.5 pl-3.5 pr-2 text-[13.5px] font-semibold">Total</td>
                      <td className="num whitespace-nowrap py-2.5 pl-2 pr-3.5 text-right text-[13.5px] font-semibold">
                        {rupees(summary.billed)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          <div className="mt-4 sm:mt-5">
            <SectionTitle hint="What came in, by mode">Collected by mode</SectionTitle>
            <Card className="divide-y divide-line">
              {Object.entries(data.by_mode).map(([mode, amount]) => (
                <div key={mode} className="flex items-center justify-between px-3.5 py-2.5">
                  <span className="text-[13.5px]">{MODE_LABEL[mode]}</span>
                  <span className={`num text-[14.5px] ${amount > 0 ? '' : 'text-ink-faint'}`}>{rupees(amount)}</span>
                </div>
              ))}
            </Card>
          </div>

          {Number(days) === 0 && (
            <Card className="mt-4 border-settled/30 bg-settled-tint p-4">
              <p className="text-[11.5px] uppercase tracking-wider text-ink-soft">Cash in hand</p>
              <p className="num text-[26px] leading-none font-medium text-settled-deep">{rupees(data.cash_in_hand)}</p>
              <p className="mt-1 text-[12.5px] text-ink-soft">Deposit this at the bank or hand it over at the office.</p>
            </Card>
          )}

          <div className="mt-5">
            <SectionTitle hint={`${data.pending.count} ${data.pending.count === 1 ? 'bill' : 'bills'} still open`}>
              Still to collect
            </SectionTitle>
            {data.pending_list.length === 0 ? (
              <Card className="p-5 text-center">
                <p className="text-[14px] font-medium">Everything on this list is closed.</p>
                <p className="mt-1 text-[13px] text-ink-faint">Nice work — nothing outstanding.</p>
              </Card>
            ) : (
              <div className="overflow-hidden rounded-xl border border-line bg-surface">
                {data.pending_list.slice(0, 12).map((b) => (
                  <Link key={b.id} to={withBack(`/field/bills/${b.id}`, '/field/me')} className="flex items-center gap-3 border-b border-line px-3.5 py-3.5 last:border-0 active:bg-paper min-h-[52px]">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14.5px] font-medium">{b.shop_name}</p>
                      <p className="num truncate text-[11.5px] text-ink-faint">{b.invoice_no}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="num text-[14.5px]">{rupees(b.balance)}</p>
                      <p className="num text-[11.5px] text-ink-faint">of {rupees(b.amount)}</p>
                    </div>
                    <svg viewBox="0 0 24 24" width="15" height="15" className="shrink-0 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="mt-6 space-y-2.5">
            <Link to="/field/end"><Btn variant="primary" size="lg" block>End day</Btn></Link>
            <Link to="/field/upload"><Btn size="lg" block>Add bills</Btn></Link>
          </div>

          <QueuedList />

          <div className="mt-6 space-y-3 border-t border-line pt-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[12.5px] text-ink-faint">
                {online ? 'Connected' : 'Offline — entries are saved on this phone'}
                {queue.length > 0 ? ` · ${queue.length} waiting` : ''}
              </p>
              <button
                type="button"
                onClick={logout}
                className="text-[13px] font-medium text-ink-soft underline underline-offset-4"
              >
                Sign out
              </button>
            </div>
            <button
              type="button"
              onClick={toggleDark}
              className="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2.5 text-[13px] text-ink-soft hover:bg-surface transition-colors"
            >
              {dark ? (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              )}
              {dark ? 'Switch to light mode' : 'Switch to dark mode'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
