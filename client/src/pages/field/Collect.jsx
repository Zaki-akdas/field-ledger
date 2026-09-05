import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useApi, useTitle, fileToCompressedDataUrl, newId } from '../../lib/hooks.js';
import { useSync, useToast } from '../../lib/context.jsx';
import { api } from '../../lib/api.js';
import { money } from '../../lib/format.js';
import { originOf } from '../../lib/fieldBack.js';
import DenomGrid, { decompose, totalOf } from '../../components/DenomGrid.jsx';
import UpiQr from '../../components/UpiQr.jsx';
import {
  Btn, Card, ErrorNote, Field, Input, Loading, Select, cx,
} from '../../components/ui.jsx';
import { FieldHeader } from '../../components/FieldLayout.jsx';

const MODES = [
  { key: 'cash', label: 'Cash' },
  { key: 'online', label: 'Online' },
  { key: 'cheque', label: 'Cheque' },
  { key: 'credit_note', label: 'Credit note' },
];

const CN_REASONS = ['Rate difference', 'Returned empty crates', 'Scheme credit', 'Damaged goods adjustment', 'Other'];
const BANKS = ['HDFC Bank', 'ICICI Bank', 'State Bank of India', 'Axis Bank', 'Bank of India', 'Punjab National Bank', 'Kotak Mahindra Bank', 'Other'];

async function attach(file, online) {
  if (!file) return {};
  if (online) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await api.upload('/attachments', fd);
    return { attachment: r.path };
  }
  return { attachment_data: await fileToCompressedDataUrl(file) };
}

export default function Collect() {
  const { id } = useParams();
  useTitle('Collect');
  const navigate = useNavigate();
  const location = useLocation();
  // Where the salesman tapped the bill from — return there after saving,
  // and keep the origin on the bill link when backing out to the detail.
  const back = originOf(location);
  const { push } = useToast();
  const { online, save } = useSync();
  const { data, loading } = useApi(`/bills/${id}`);

  const [modes, setModes] = useState(['cash']);
  const [counts, setCounts] = useState({});
  const [online_, setOnlineEntry] = useState({ amount: '', ref_no: '', note: '', file: null });
  const [cheque, setCheque] = useState({ amount: '', ref_no: '', bank: '', cheque_date: '', file: null });
  const [credit, setCredit] = useState({ amount: '', ref_no: '', note: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ratio, setRatio] = useState(null);        // cash % of the split — null = untouched
  const [usual, setUsual] = useState(null);        // this shop's learned payment pattern
  const [usualDone, setUsualDone] = useState(false); // auto-applied at most once per visit

  const bill = data?.bill;
  const outstanding = bill ? Math.max(0, bill.expected_amount - bill.collected_amount) : 0;

  // This shop's usual payment mix, from its settled history — offered as a
  // one-tap chip and auto-filled the first time the screen opens.
  useEffect(() => {
    let alive = true;
    if (bill?.shop_id) {
      api.get(`/shops/${bill.shop_id}/payment-pattern`)
        .then((r) => { if (alive) setUsual(r.pattern); })
        .catch(() => { /* offline: the chips just lose the Usual option */ });
    }
    return () => { alive = false; };
  }, [bill?.shop_id]);

  const usualCashPct = usual && usual.total > 0 ? Math.round((usual.cash / usual.total) * 100) : null;

  // Auto-fill the usual split once, when the screen opens clean. A shop that
  // always pays cash gets no auto-fill (nothing to split); a revisit with a
  // draft in progress is never overwritten.
  useEffect(() => {
    if (!bill || usualDone) return;
    const touched = online_.amount || cheque.amount || credit.amount
      || Object.values(counts).some((c) => Number(c) > 0);
    if (touched) { setUsualDone(true); return; }
    const pct = usualCashPct;
    if (pct == null || pct >= 100) return;
    const cashAmt = Math.ceil((outstanding * pct) / 100);
    const onlineAmt = outstanding - cashAmt;
    if (onlineAmt <= 0) return;
    setRatio(pct);
    setModes((m) => {
      const next = new Set(m);
      next.add('cash');
      next.add('online');
      return MODES.map((x) => x.key).filter((k) => next.has(k));
    });
    setCounts(decompose(cashAmt));
    setOnlineEntry((o) => ({ ...o, amount: String(onlineAmt) }));
    setUsualDone(true);
    push(`Usual here: ${pct}% cash · ${100 - pct}% online — filled it in.`, 'success');
  }, [bill, usualDone, usualCashPct, outstanding, counts, online_, cheque, credit, push]);

  const cashTotal = useMemo(() => totalOf(counts), [counts]);
  const total = useMemo(
    () => cashTotal + (Number(online_.amount) || 0) + (Number(cheque.amount) || 0) + (Number(credit.amount) || 0),
    [cashTotal, online_, cheque, credit],
  );

  // Custom split at the chosen ratio: whatever the other modes haven't
  // covered is divided cash/online. The odd rupee goes to cash — notes and
  // coins absorb it more naturally than a bank transfer.
  const otherTotal = (Number(cheque.amount) || 0) + (Number(credit.amount) || 0);
  const restOutstanding = Math.max(0, outstanding - otherTotal);
  const pct = ratio ?? 50;
  const cashShare = Math.ceil((restOutstanding * pct) / 100);
  const onlineShare = restOutstanding - cashShare;
  const canSplit = restOutstanding > 1 && onlineShare > 0;
  const applySplit = () => {
    setModes((m) => {
      const next = new Set(m);
      if (cashShare > 0) next.add('cash');
      if (onlineShare > 0) next.add('online');
      return MODES.map((x) => x.key).filter((k) => next.has(k));
    });
    if (cashShare > 0) setCounts(decompose(cashShare));
    if (onlineShare > 0) setOnlineEntry((o) => ({ ...o, amount: String(onlineShare) }));
  };

  const toggleMode = (key) => setModes((m) => (m.includes(key) ? m.filter((x) => x !== key) : [...m, key]));

  const fillCash = (amount) => setCounts(decompose(amount));

  const validate = () => {
    if (total <= 0) return 'Enter an amount in at least one mode before saving.';
    if (total > outstanding + 1) return `You’ve entered ₹${money(total)} but only ₹${money(outstanding)} is outstanding on this bill.`;
    if (modes.includes('online') && (Number(online_.amount) || 0) > 0 && !online_.ref_no.trim()) return 'Add the UTR or reference number for the online payment.';
    if (modes.includes('cheque') && (Number(cheque.amount) || 0) > 0 && (!cheque.ref_no.trim() || !cheque.bank)) return 'Add the cheque number and the bank name.';
    if (modes.includes('credit_note') && (Number(credit.amount) || 0) > 0 && !credit.ref_no.trim()) return 'Add the credit note number.';
    return null;
  };

  const submit = async () => {
    const problem = validate();
    if (problem) { setError(problem); return; }
    setError(null);
    setBusy(true);
    try {
      const entries = [];
      if (cashTotal > 0) {
        entries.push({
          mode: 'cash',
          amount: cashTotal,
          denominations: Object.entries(counts)
            .filter(([, c]) => Number(c) > 0)
            .map(([denom, count]) => ({ denom: Number(denom), count: Number(count) })),
        });
      }
      if ((Number(online_.amount) || 0) > 0) {
        entries.push({ mode: 'online', amount: Number(online_.amount), ref_no: online_.ref_no.trim(), note: online_.note.trim(), ...(await attach(online_.file, online)) });
      }
      if ((Number(cheque.amount) || 0) > 0) {
        entries.push({
          mode: 'cheque', amount: Number(cheque.amount), ref_no: cheque.ref_no.trim(),
          bank: cheque.bank, cheque_date: cheque.cheque_date || null, ...(await attach(cheque.file, online)),
        });
      }
      if ((Number(credit.amount) || 0) > 0) {
        entries.push({ mode: 'credit_note', amount: Number(credit.amount), ref_no: credit.ref_no.trim(), note: credit.note });
      }

      const payload = { bill_id: Number(id), entries, client_id: newId() };
      const result = await save({
        type: 'collection',
        payload,
        label: `Collection · ${bill?.invoice_no} · ₹${money(total)}`,
      });

      if (result.queued) {
        push('No signal — collection saved on this phone. It will sync on its own.', 'success');
      } else {
        push(`Collection saved — ₹${money(total)} against ${bill?.invoice_no}.`, 'success');
      }
      navigate(back ?? '/field/collect', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading label="Opening bill…" />;
  if (!bill) return <div className="py-10"><ErrorNote>Bill not found.</ErrorNote></div>;

  const shortfall = outstanding - total;

  return (
    <div className="pb-40">
      <FieldHeader title={bill ? `Collect · ${bill.invoice_no}` : 'Collect'} back={`/field/bills/${id}`} backState={back ? { back } : undefined} />

      <Card className="p-4">
        <p className="num text-[13.5px] text-ink-soft">{bill.invoice_no}</p>
        <p className="mt-0.5 text-[17px] font-semibold leading-tight tracking-tight">{bill.shop_name}</p>
        <div className="mt-3 flex items-end justify-between gap-3 border-t border-line pt-3">
          <div>
            <p className="text-[11.5px] uppercase tracking-wider text-ink-faint">To collect</p>
            <p className="num text-[26px] leading-none font-medium">₹{money(outstanding)}</p>
          </div>
          {(bill.collected_amount || 0) > 0 && (
            <p className="num text-[12.5px] text-settled">₹{money(bill.collected_amount)} already in</p>
          )}
        </div>
      </Card>

      <div className="mt-5">
        <p className="label">How was this paid?</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-1.5">
          {MODES.map((m) => {
            const on = modes.includes(m.key);
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => toggleMode(m.key)}
                aria-pressed={on}
                className={cx(
                  'flex h-12 items-center justify-center rounded-lg border px-2 text-center text-[13.5px] font-medium leading-tight transition-colors active:scale-[0.97] sm:h-11 sm:text-[12.5px]',
                  on ? 'border-ink bg-ink text-paper' : 'border-line bg-surface text-ink-soft hover:border-line-strong active:bg-paper',
                )}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[12px] text-ink-faint">Pick any combination — most bills are split.</p>
        {canSplit && (
          <div className="anim-fade mt-2.5 rounded-lg border border-line bg-surface p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {[...new Set([25, 50, 75, ...(usualCashPct != null ? [usualCashPct] : [])])].sort((a, b) => a - b).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setRatio(p)}
                  aria-pressed={pct === p}
                  className={cx(
                    'num h-9 rounded-full border px-3 text-[12.5px] font-medium transition-colors active:scale-[0.97]',
                    pct === p ? 'border-ink bg-ink text-paper' : 'border-line bg-paper text-ink-soft hover:border-line-strong active:bg-paper',
                  )}
                >
                  {usualCashPct === p ? `Usual ${p}/${100 - p}` : `${p}/${100 - p}`}
                </button>
              ))}
              <span className="ml-auto text-[11.5px] text-ink-faint">cash / online</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={pct}
              onChange={(e) => setRatio(Number(e.target.value))}
              aria-label="Cash share of the split"
              className="mt-3 w-full accent-ink"
            />
            <div className="flex justify-between text-[11px] text-ink-faint">
              <span>all cash</span>
              <span className="num">{pct}/{100 - pct}</span>
              <span>all online</span>
            </div>
            <Btn size="sm" variant="ghost" block className="mt-2.5" onClick={applySplit}>
              Split {pct}/{100 - pct} ·{'\u00A0'}₹{money(cashShare)} cash + ₹{money(onlineShare)} online
            </Btn>
          </div>
        )}
      </div>

      {modes.includes('cash') && (
        <Card className="mt-4 p-4">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-[13px] font-semibold uppercase tracking-wider text-ink-soft">Cash</p>
              <p className="text-[12px] text-ink-faint">Count the bundle — notes, then coins</p>
            </div>
            <div className="text-right">
              <p className="num text-[22px] leading-none font-medium">₹{money(cashTotal)}</p>
            </div>
          </div>

          <DenomGrid counts={counts} onChange={setCounts} className="mt-3.5" />

          <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Btn size="sm" onClick={() => fillCash(outstanding)}>Fill ₹{money(outstanding)}</Btn>
            <Btn size="sm" onClick={() => fillCash(outstanding - total + cashTotal)}>Fill balance ₹{money(Math.max(0, outstanding - total + cashTotal))}</Btn>
            <Btn size="sm" variant="ghost" onClick={() => setCounts({})}>Clear</Btn>
          </div>
        </Card>
      )}

      {modes.includes('online') && (
        <Card className="mt-4 p-4 space-y-3">
          <div className="flex items-end justify-between">
            <p className="text-[13px] font-semibold uppercase tracking-wider text-ink-soft">Online</p>
            <p className="num text-[20px] leading-none">₹{money(Number(online_.amount) || 0)}</p>
          </div>
          <UpiQr amount={Number(online_.amount) || 0} note={bill?.invoice_no || ''} />
          <Field label="Amount">
            <Input mono inputMode="decimal" value={online_.amount} onChange={(e) => setOnlineEntry({ ...online_, amount: e.target.value })} placeholder="0" />
          </Field>
          <Field label="UTR / reference number" hint="Copy it from the payment screen — the office reconciles on this.">
            <Input mono value={online_.ref_no} onChange={(e) => setOnlineEntry({ ...online_, ref_no: e.target.value })} placeholder="UTR123456789012" autoCapitalize="characters" />
          </Field>
          <Field label="Method (optional)">
            <Select value={online_.note} onChange={(e) => setOnlineEntry({ ...online_, note: e.target.value })}>
              <option value="">Select…</option>
              <option>UPI — GPay</option>
              <option>UPI — PhonePe</option>
              <option>UPI — Paytm</option>
              <option>NEFT</option>
              <option>IMPS</option>
              <option>RTGS</option>
            </Select>
          </Field>
          <Field label="Screenshot (optional)" hint={online ? '' : 'Photos attach after sync if there’s no signal.'}>
            <input
              type="file"
              accept="image/*"
              className="block w-full text-[13px] text-ink-soft file:mr-3 file:rounded-md file:border-0 file:bg-paper file:px-3 file:py-2 file:text-[13px] file:font-medium file:text-ink"
              onChange={(e) => setOnlineEntry({ ...online_, file: e.target.files?.[0] || null })}
            />
          </Field>
        </Card>
      )}

      {modes.includes('cheque') && (
        <Card className="mt-4 p-4 space-y-3">
          <div className="flex items-end justify-between">
            <p className="text-[13px] font-semibold uppercase tracking-wider text-ink-soft">Cheque</p>
            <p className="num text-[20px] leading-none">₹{money(Number(cheque.amount) || 0)}</p>
          </div>
          <Field label="Amount">
            <Input mono inputMode="decimal" value={cheque.amount} onChange={(e) => setCheque({ ...cheque, amount: e.target.value })} placeholder="0" />
          </Field>
          <Field label="Cheque number">
            <Input mono value={cheque.ref_no} onChange={(e) => setCheque({ ...cheque, ref_no: e.target.value })} placeholder="000123" inputMode="numeric" />
          </Field>
          <Field label="Bank">
            <Select value={cheque.bank} onChange={(e) => setCheque({ ...cheque, bank: e.target.value })}>
              <option value="">Select bank…</option>
              {BANKS.map((b) => <option key={b}>{b}</option>)}
            </Select>
          </Field>
          <Field label="Cheque date">
            <Input type="date" mono value={cheque.cheque_date} onChange={(e) => setCheque({ ...cheque, cheque_date: e.target.value })} />
          </Field>
          <Field label="Photo of the cheque (optional)">
            <input
              type="file"
              accept="image/*"
              className="block w-full text-[13px] text-ink-soft file:mr-3 file:rounded-md file:border-0 file:bg-paper file:px-3 file:py-2 file:text-[13px] file:font-medium file:text-ink"
              onChange={(e) => setCheque({ ...cheque, file: e.target.files?.[0] || null })}
            />
          </Field>
        </Card>
      )}

      {modes.includes('credit_note') && (
        <Card className="mt-4 p-4 space-y-3">
          <div className="flex items-end justify-between">
            <p className="text-[13px] font-semibold uppercase tracking-wider text-ink-soft">Credit note</p>
            <p className="num text-[20px] leading-none">₹{money(Number(credit.amount) || 0)}</p>
          </div>
          <Field label="Amount">
            <Input mono inputMode="decimal" value={credit.amount} onChange={(e) => setCredit({ ...credit, amount: e.target.value })} placeholder="0" />
          </Field>
          <Field label="Credit note number">
            <Input mono value={credit.ref_no} onChange={(e) => setCredit({ ...credit, ref_no: e.target.value })} placeholder="CN/2026/1042" />
          </Field>
          <Field label="Reason">
            <Select value={credit.note} onChange={(e) => setCredit({ ...credit, note: e.target.value })}>
              <option value="">Select reason…</option>
              {CN_REASONS.map((r) => <option key={r}>{r}</option>)}
            </Select>
          </Field>
        </Card>
      )}

      <ErrorNote className="mt-4">{error}</ErrorNote>

      {/* Sticky total + the one action that matters */}
      <div className="fixed inset-x-0 bottom-[max(56px,calc(48px+env(safe-area-inset-bottom)))] z-30 border-t border-line bg-surface/95 backdrop-blur safe-bottom">
        <div className="mx-auto max-w-[560px] px-4 py-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[12.5px] text-ink-soft">Collecting</span>
            <span className="flex items-baseline gap-2">
              <span className="num text-[20px] font-medium">₹{money(total)}</span>
              <span className="num text-[12.5px] text-ink-faint">of ₹{money(outstanding)}</span>
            </span>
          </div>
          {total > 0 && shortfall > 1 && (
            <p className="mb-2 text-[12.5px] text-attention">
              ₹{money(shortfall)} will stay outstanding on this bill.
            </p>
          )}
          <Btn variant="settled" size="lg" block disabled={busy || total <= 0} onClick={submit}>
            {busy ? 'Saving…' : `Save collection · ₹${money(total)}`}
          </Btn>
        </div>
      </div>
    </div>
  );
}
