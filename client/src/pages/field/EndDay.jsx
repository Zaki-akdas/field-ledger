import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useToast } from '../../lib/context.jsx';
import { api } from '../../lib/api.js';
import { todayISO, money, MODE_LABEL } from '../../lib/format.js';
import {
  Btn, Card, ErrorNote, Field, KeyValue, Loading, Money, Textarea, Variance,
} from '../../components/ui.jsx';
import { FieldHeader } from '../../components/FieldLayout.jsx';

export default function EndDay() {
  useTitle('End day');
  const navigate = useNavigate();
  const { push } = useToast();
  const today = todayISO();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { data: sessionData, loading, reload: reloadSession } = useApi('/session/today');
  const { data: dash, reload } = useApi(`/me/dashboard?from=${today}&to=${today}`);

  const ended = Boolean(sessionData?.session?.ended_at);

  const end = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/session/end', { work_date: today, note: note.trim() || null });
      push('Day ended. Your book is closed for today.', 'success');
      reload();
      reloadSession();
    } catch (err) {
      setError(err.offline ? 'You need signal to close the day. Your entries are safe.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading || !dash) return <Loading label="Adding up the day…" />;

  return (
    <div className="pb-10">
      <FieldHeader title="End day" back="/field/me" />

      {ended ? (
        <Card className="border-settled/30 bg-settled-tint p-5 text-center">
          <p className="text-[13px] font-semibold uppercase tracking-wider text-settled-deep">Day ended</p>
          <p className="num mt-1 text-[15px] text-ink-soft">{String(sessionData.session.ended_at).slice(11, 16)}</p>
          {sessionData.session.closing_note && (
            <p className="mt-3 text-[14px] text-ink">{sessionData.session.closing_note}</p>
          )}
          <p className="mt-3 text-[13px] text-ink-soft">
            Come back tomorrow — the office can see today’s numbers already.
          </p>
        </Card>
      ) : (
        <Card className="p-4">
          <p className="text-[12px] font-medium uppercase tracking-wider text-ink-faint">Today’s reconciliation</p>
          <dl className="mt-2 divide-y divide-line">
            <KeyValue label="Bills on the book" value={<span className="num">{dash.bill_count}</span>} />
            <KeyValue label="Less: cancelled" value={`−₹${money(dash.cancelled.amount)}`} tone={dash.cancelled.amount ? 'text-attention' : 'text-ink-faint'} />
            <KeyValue label="Less: short items" value={`−₹${money(dash.short.amount)}`} tone={dash.short.amount ? 'text-attention' : 'text-ink-faint'} />
            <KeyValue label="Expected" value={`₹${money(dash.expected)}`} tone="text-ink font-semibold" />
            <KeyValue label="Collected" value={`₹${money(dash.collected)}`} tone="text-settled" />
            <KeyValue label="Variance" value={<Variance value={dash.variance} />} />
          </dl>
        </Card>
      )}

      <Card className="mt-4 p-4">
        <p className="text-[12px] font-medium uppercase tracking-wider text-ink-faint">Cash to deposit</p>
        <p className="num mt-1 text-[28px] leading-none font-medium text-settled-deep">₹{money(dash.cash_in_hand)}</p>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 sm:grid-cols-3 sm:gap-2">
          {['online', 'cheque', 'credit_note'].map((m) => (
            <div key={m}>
              <p className="text-[11px] uppercase tracking-wider text-ink-faint">{MODE_LABEL[m]}</p>
              <p className="num text-[13.5px]">₹{money(dash.by_mode[m])}</p>
            </div>
          ))}
        </div>
      </Card>

      {dash.pending.count > 0 && (
        <div className="mt-4 rounded-xl border border-attention/35 bg-attention-tint p-4">
          <p className="text-[13.5px] font-medium text-attention-deep">
            <span className="num">{dash.pending.count}</span> {dash.pending.count === 1 ? 'bill is' : 'bills are'} still open
          </p>
          <p className="mt-0.5 text-[13px] text-ink">
            <Money value={dash.pending.amount} className="font-medium" /> outstanding. They stay on your route tomorrow
            — the office sees them as variance for today.
          </p>
          <Link to="/field/collect" className="mt-3 inline-block text-[13.5px] font-medium text-attention-deep underline">
            Finish collections
          </Link>
        </div>
      )}

      {!ended && (
        <>
          <div className="mt-4">
            <Field label="Note for the office (optional)">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything that explains today’s variance" />
            </Field>
          </div>
          <ErrorNote className="mt-4">{error}</ErrorNote>
          <div className="mt-6 space-y-2.5">
            <Btn variant="primary" size="lg" block disabled={busy} onClick={end}>
              {busy ? 'Closing…' : 'End day'}
            </Btn>
            <Btn variant="ghost" block onClick={() => navigate('/field/me')}>Not yet</Btn>
          </div>
        </>
      )}
    </div>
  );
}
