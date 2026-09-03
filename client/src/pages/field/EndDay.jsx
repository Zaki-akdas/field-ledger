import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useAuth, useToast } from '../../lib/context.jsx';
import { api, downloadExport, shareExport } from '../../lib/api.js';
import { todayISO, money, MODE_LABEL, dateLabel } from '../../lib/format.js';
import {
  Btn, Card, ErrorNote, Field, KeyValue, Loading, Money, SectionTitle, Textarea, Variance,
} from '../../components/ui.jsx';
import { FieldHeader } from '../../components/FieldLayout.jsx';

/* Same ASCII code-unit order the server uses (ORDER BY invoice_no), so the
   S.No column lines up with the office's export of the same day. */
const byInvoice = (a, b) => (a.invoice_no < b.invoice_no ? -1 : a.invoice_no > b.invoice_no ? 1 : 0);

export default function EndDay() {
  useTitle('End day');
  const navigate = useNavigate();
  const { user } = useAuth();
  const { push } = useToast();
  const today = todayISO();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(null); // 'xlsx' | 'pdf'
  const [sharing, setSharing] = useState(false);
  const { data: sessionData, loading, reload: reloadSession } = useApi('/session/today');
  const { data: dash, reload } = useApi(`/me/dashboard?from=${today}&to=${today}`);
  const billsRes = useApi(`/bills?date=${today}`);

  const ended = Boolean(sessionData?.session?.ended_at);

  /* Today's register in the office's CO-SHIP layout: one line per invoice
     (S.No / invoice / party / amount), cancelled bills excluded, ordered by
     invoice number — exactly the rows the Excel/PDF export contains. */
  const register = useMemo(() => {
    const all = billsRes.data?.bills || [];
    // Balance = amount minus shorts and collections — same expected-based
    // figure as the office register and the export, so the sheet they print
    // and the file the office opens agree line by line.
    const derived = (b) => {
      const collected = Math.round(Number(b.collected_amount || 0) * 100) / 100;
      const balance = Math.max(0, Math.round(((Number(b.amount || 0) - Number(b.short_amount || 0)) * 100 - collected * 100)) / 100);
      return { collected, balance };
    };
    const rows = all
      .filter((b) => b.status !== 'cancelled')
      .sort(byInvoice)
      .map((b, i) => ({ ...b, sno: i + 1, ...derived(b) }));
    const sum = (f) => rows.reduce((a, b) => a + Number(f(b) || 0), 0);
    return {
      rows,
      count: rows.length,
      billed: sum((b) => b.amount),
      collected: sum((b) => b.collected),
      balance: sum((b) => b.balance),
      cancelled: all.length - rows.length,
    };
  }, [billsRes.data]);

  const runExport = async (format) => {
    setExporting(format);
    try {
      const name = await downloadExport('collection', { from: today, to: today }, format);
      push(format === 'pdf' ? 'PDF ready — open it to print or share.' : `Excel file ready — ${name}`, 'success');
    } catch (err) {
      push(err.message, 'error');
    } finally {
      setExporting(null);
    }
  };

  const printRegister = () => {
    if (typeof window === 'undefined' || typeof window.print !== 'function') return;
    document.body.classList.add('printing');
    const cleanup = () => {
      document.body.classList.remove('printing');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    // Fallback for engines that never fire afterprint.
    setTimeout(cleanup, 1000);
    window.print();
  };

  const end = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/session/end', { work_date: today, note: note.trim() || null });
      if (res?.report_email === 'sent') {
        push('Day ended. The collection report was emailed to the office.', 'success');
      } else if (res?.report_email === 'failed') {
        push('Day ended — but emailing the report failed. Share it manually from below.', 'error');
      } else {
        push('Day ended. Your book is closed for today.', 'success');
      }
      reload();
      reloadSession();
    } catch (err) {
      setError(err.offline ? 'You need signal to close the day. Your entries are safe.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  const shareReport = async () => {
    setSharing(true);
    try {
      const how = await shareExport('collection', { from: today, to: today }, 'pdf');
      push(how === 'shared' ? 'Report shared — send it to the office.' : 'PDF downloaded — email or WhatsApp it to the office.', 'success');
    } catch (err) {
      push(err.message, 'error');
    } finally {
      setSharing(false);
    }
  };

  if (loading || !dash || billsRes.loading) return <Loading label="Adding up the day…" />;

  /* The register sheet — shown on screen inside a Card and printed via the
     portal (same markup, so what you see is what goes to paper). */
  const sheet = register.count === 0 ? null : (
    <div>
      <div className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-3 sm:px-4">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold leading-tight">Field Ledger — Collection report</p>
          <p className="num mt-0.5 truncate text-[11.5px] text-ink-faint">{user?.code} · {user?.name}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[12.5px] font-medium">{dateLabel(today)}</p>
          <p className="text-[11px] text-ink-faint">{register.count} {register.count === 1 ? 'bill' : 'bills'}</p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-faint">
              <th className="w-12 py-2.5 pl-3.5 pr-2 font-semibold">S.No</th>
              <th className="py-2.5 px-2 font-semibold">Invoice</th>
              <th className="py-2.5 px-2 font-semibold">Party</th>
              <th className="py-2.5 px-2 text-right font-semibold">Amount</th>
              <th className="py-2.5 px-2 text-right font-semibold">Collected</th>
              <th className="py-2.5 pl-2 pr-3.5 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {register.rows.map((b) => (
              <tr key={b.id}>
                <td className="num py-2.5 pl-3.5 pr-2 text-ink-faint">{b.sno}</td>
                <td className="num whitespace-nowrap py-2.5 px-2">{b.invoice_no}</td>
                <td className="max-w-[160px] truncate py-2.5 px-2">{b.shop_name}</td>
                <td className="num whitespace-nowrap py-2.5 pl-2 pr-3.5 text-right">₹{money(b.amount)}</td>
                <td className="num whitespace-nowrap py-2.5 pl-2 pr-3.5 text-right">₹{money(b.collected)}</td>
                <td className={`num whitespace-nowrap py-2.5 pl-2 pr-3.5 text-right ${b.balance > 0.5 ? 'font-medium text-attention' : 'text-ink-faint'}`}>₹{money(b.balance)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line bg-surface">
              <td colSpan={3} className="py-2.5 pl-3.5 pr-2 text-[13.5px] font-semibold">
                Grand total · {register.count} {register.count === 1 ? 'bill' : 'bills'}
              </td>
              <td className="num whitespace-nowrap py-2.5 pl-2 pr-3.5 text-right text-[13.5px] font-semibold">
                ₹{money(register.billed)}
              </td>
              <td className="num whitespace-nowrap py-2.5 pl-2 pr-3.5 text-right text-[13.5px] font-semibold">
                ₹{money(register.collected)}
              </td>
              <td className="num whitespace-nowrap py-2.5 pl-2 pr-3.5 text-right text-[13.5px] font-semibold">
                ₹{money(register.balance)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );

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

      {/* Day's collection report — the CO-SHIP register the salesman can
          print or export in the same format the office files. */}
      <div className="mt-5">
        <SectionTitle
          hint={`${dateLabel(today)} · ${register.count} ${register.count === 1 ? 'bill' : 'bills'}${register.cancelled ? ` · ${register.cancelled} cancelled excluded` : ''}`}
        >
          Day's collection report
        </SectionTitle>
        <div className="mb-2 flex flex-wrap gap-1.5">
          <Btn size="sm" variant="secondary" disabled={Boolean(exporting) || sharing} onClick={shareReport}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <path d="M8.6 10.7l6.8-3.4M8.6 13.3l6.8 3.4" />
            </svg>
            Share
          </Btn>
          <Btn size="sm" variant="secondary" disabled={Boolean(exporting) || sharing} onClick={printRegister}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 9V2h12v7" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" />
            </svg>
            Print
          </Btn>
          <Btn size="sm" variant="secondary" disabled={Boolean(exporting) || sharing} onClick={() => runExport('xlsx')}>
            Excel
          </Btn>
          <Btn size="sm" variant="secondary" disabled={Boolean(exporting) || sharing} onClick={() => runExport('pdf')}>
            PDF
          </Btn>
        </div>

        {sheet ? (
          <Card className="overflow-hidden !p-0">{sheet}</Card>
        ) : (
          <Card className="p-6 text-center">
            <p className="text-[14px] font-medium">No bills on today's book.</p>
            <p className="mt-1 text-[13px] text-ink-faint">Upload today's invoices from “Add bills” to see your register here.</p>
          </Card>
        )}
      </div>

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

      {/* The printable register lives outside #root so printing can hide the
          whole app and paginate the sheet normally. Hidden on screen. */}
      {sheet && createPortal(<div id="day-print-doc">{sheet}</div>, document.body)}
    </div>
  );
}
