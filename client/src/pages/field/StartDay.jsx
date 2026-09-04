import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useAuth, useSync, useToast } from '../../lib/context.jsx';
import { todayISO, money } from '../../lib/format.js';
import { api } from '../../lib/api.js';
import {
  Btn, Card, EmptyState, ErrorNote, Loading, Money, ProgressBar,
} from '../../components/ui.jsx';
import StepRail from '../../components/StepRail.jsx';
import { QueuedList } from '../../components/FieldLayout.jsx';

const STEPS = [
  { label: 'Start day', to: '/field/start' },
  { label: 'Visit shop', to: '/field/bills' },
  { label: 'Collect', to: '/field/collect' },
  { label: 'End day', to: '/field/end' },
];

export default function StartDay() {
  useTitle('Start day');
  const { user } = useAuth();
  const { push } = useToast();
  const { online } = useSync();
  const navigate = useNavigate();
  const today = todayISO();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { data: sessionData, loading, reload } = useApi('/session/today');
  const { data: dash, reload: reloadDash } = useApi(`/me/dashboard?from=${today}&to=${today}`);

  const session = sessionData?.session;
  const baseline = sessionData?.baseline;
  const started = Boolean(session?.started_at);
  const ended = Boolean(session?.ended_at);
  const step = ended ? 5 : started ? (dash && (dash.bills.delivered + dash.bills.cancelled) > 0 ? 3 : 2) : 1;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/session/start', { work_date: today });
      push('Day started. Good luck on the route.', 'success');
      reload();
    } catch (err) {
      if (err.offline) push('No signal — start the day once you’re back online.', 'error');
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading />;

  return (
    <div>
      <div className="mb-5">
        <p className="text-[12px] uppercase tracking-wider text-ink-faint">Signed in</p>
        <h1 className="text-[22px] font-semibold tracking-tight">{user?.name}</h1>
        <p className="num text-[13px] text-ink-soft">{user?.code}</p>
      </div>

      <StepRail steps={STEPS} current={step} onStep={(to) => navigate(to)} className="mb-6" />

      <Card className="p-5">
        <p className="text-[12px] font-medium uppercase tracking-wider text-ink-faint">Today’s book</p>
        {baseline && baseline.bill_count > 0 ? (
          <>
            <p className="num mt-1.5 text-[34px] leading-none font-medium">₹{money(baseline.amount)}</p>
            <p className="mt-1.5 text-[13.5px] text-ink-soft">
              across <span className="num">{baseline.bill_count}</span> {baseline.bill_count === 1 ? 'bill' : 'bills'} assigned to you
            </p>
            {dash && (
              <div className="mt-4">
                <ProgressBar value={(dash.bills.delivered || 0) + (dash.bills.cancelled || 0)} max={baseline.bill_count} />
                <p className="mt-1.5 text-[12.5px] text-ink-faint">
                  <span className="num">{(dash.bills.delivered || 0) + (dash.bills.cancelled || 0)}</span> of{' '}
                  <span className="num">{baseline.bill_count}</span> closed ·{' '}
                  <span className="num">{baseline.bill_count - (dash.bills.delivered || 0) - (dash.bills.cancelled || 0)}</span> to go
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="mt-3">
            <EmptyState
              title="No bills yet — upload today’s batch to start"
              body="Drop in the Excel sheet from dispatch, or add a bill by hand."
              action={<Link to="/field/upload"><Btn variant="primary" size="sm">Upload bills</Btn></Link>}
            />
          </div>
        )}
      </Card>

      {started && (
        <Card className="mt-4 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[13.5px] font-medium">Day started</p>
              <p className="num text-[12.5px] text-ink-faint">{String(session.started_at).slice(11, 16)}</p>
            </div>
            <span className="rounded-full border border-settled/30 bg-settled-tint px-2.5 py-1 text-[11.5px] font-medium text-settled-deep">
              On the route
            </span>
          </div>
        </Card>
      )}

      <ErrorNote className="mt-4">{error}</ErrorNote>

      {!online && (
        <p className="mt-3 rounded-lg border border-line bg-surface px-3.5 py-2.5 text-[12.5px] text-ink-soft">
          You’re offline. Collections, shortages and cancellations still save on this phone — only
          starting and ending the day needs signal.
        </p>
      )}

      <div className="mt-6 space-y-2.5">
        {!started ? (
          <>
            <Btn
              variant="primary"
              size="lg"
              block
              onClick={start}
              disabled={busy || !baseline || baseline.bill_count === 0}
            >
              {busy ? 'Starting…' : 'Start day'}
            </Btn>
            <p className="text-center text-[12.5px] text-ink-faint">
              Starting the day records your opening book so the office can see it.
            </p>
          </>
        ) : (
          <>
            <Btn variant="primary" size="lg" block onClick={() => navigate('/field/bills')}>
              Open today’s bills
            </Btn>
            <Btn variant="secondary" size="lg" block onClick={() => navigate('/field/collect')}>
              Go to collections
            </Btn>
          </>
        )}
        <Btn variant="ghost" block onClick={() => { reload(); reloadDash(); }}>
          Refresh book
        </Btn>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-2.5 sm:gap-3">
        <Link to="/field/upload" className="panel p-3.5 hover:border-line-strong">
          <p className="text-[13.5px] font-medium">Add bills</p>
          <p className="text-[12px] text-ink-faint">Sheet, PDF or one at a time</p>
        </Link>
        <Link to="/field/me" className="panel p-3.5 hover:border-line-strong">
          <p className="text-[13.5px] font-medium">My numbers</p>
          <p className="text-[12px] text-ink-faint">Delivered, short, pending</p>
        </Link>
      </div>

      <QueuedList />

      {dash && dash.pending.count > 0 && (
        <p className="mt-4 text-center text-[12.5px] text-ink-faint">
          <Money value={dash.pending.amount} /> still outstanding across {dash.pending.count} bills
        </p>
      )}
    </div>
  );
}
