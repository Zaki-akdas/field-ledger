import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi, useTitle, useDarkMode } from '../../lib/hooks.js';
import { useAuth, useSync } from '../../lib/context.jsx';
import { todayISO, shiftISO, MODE_LABEL, rupees } from '../../lib/format.js';
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
  const { dark, toggle: toggleDark } = useDarkMode();
  const [days, setDays] = useState('0');
  const today = todayISO();
  const from = shiftISO(today, -Number(days));
  const { data, loading, error } = useApi(`/me/dashboard?from=${from}&to=${today}`);
  const session = useApi('/session/today');
  const { online, queue } = useSync();
  const { logout } = useAuth();

  const started = Boolean(session.data?.session?.started_at);
  const ended = Boolean(session.data?.session?.ended_at);
  const closed = (data?.bills?.delivered || 0) + (data?.bills?.cancelled || 0);
  const step = ended ? 5 : started ? (closed > 0 ? 3 : 2) : 1;

  return (
    <div className="pb-6">
      <div className="mb-4">
        <h1 className="text-[22px] font-semibold tracking-tight">{user?.name}</h1>
        <p className="num text-[13px] text-ink-soft">{user?.code} · {user?.phone}</p>
      </div>

      <StepRail steps={STEPS} current={step} onStep={(to) => navigate(to)} className="mb-5" />

      <Segmented className="mb-4" value={days} onChange={setDays} options={RANGES} />

      {loading ? <Loading label="Adding up…" /> : error ? <ErrorNote>{error.message}</ErrorNote> : data && (
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
                  <Link key={b.id} to={`/field/bills/${b.id}`} className="flex items-center gap-3 border-b border-line px-3.5 py-3.5 last:border-0 active:bg-paper min-h-[52px]">
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
