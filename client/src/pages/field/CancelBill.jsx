import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useApi, useTitle, newId } from '../../lib/hooks.js';
import { useSync, useToast } from '../../lib/context.jsx';
import { money } from '../../lib/format.js';
import { originOf, originState } from '../../lib/fieldBack.js';
import { Btn, Card, ErrorNote, Field, Loading, Select, Textarea } from '../../components/ui.jsx';
import { FieldHeader } from '../../components/FieldLayout.jsx';

const REASONS = [
  'Shop closed — three visits',
  'Customer refused delivery',
  'Order duplicated in batch upload',
  'Wrong stock dispatched',
  'Shop owner disputed the rate',
  'Credit limit crossed',
  'Damaged in transit',
  'Other',
];

export default function CancelBill() {
  const { id } = useParams();
  useTitle('Cancel bill');
  const navigate = useNavigate();
  const location = useLocation();
  const back = originOf(location);
  const { push } = useToast();
  const { save } = useSync();
  const { data, loading } = useApi(`/bills/${id}`);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const bill = data?.bill;

  const submit = async () => {
    if (!reason) { setError('Say why the bill is being cancelled.'); return; }
    setError(null);
    setBusy(true);
    try {
      const why = reason === 'Other' ? (note.trim() || 'Other') : (reason + (note.trim() ? ` — ${note.trim()}` : ''));
      const result = await save({
        type: 'cancellation',
        payload: { bill_id: Number(id), reason: why, client_id: newId() },
        label: `Cancelled · ${bill?.invoice_no} · ₹${money(bill?.amount || 0)}`,
      });
      push(result.queued
        ? 'No signal — cancellation saved on this phone. It will sync on its own.'
        : `Cancelled — ${bill?.invoice_no} is off the route.`, 'success');
      navigate(back ?? '/field/bills', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading label="Opening bill…" />;
  if (!bill) return <div className="py-10"><ErrorNote>Bill not found.</ErrorNote></div>;

  return (
    <div className="pb-10">
      <FieldHeader title="Mark cancelled" back={`/field/bills/${id}`} backState={back ? { back } : undefined} />

      <Card className="p-4">
        <p className="num text-[15px]">{bill.invoice_no}</p>
        <p className="mt-0.5 text-[18px] font-semibold leading-tight">{bill.shop_name}</p>
        <p className="num mt-2 text-[26px] font-medium">₹{money(bill.amount)}</p>
        <p className="text-[12.5px] text-ink-faint">This amount comes off your expected collection.</p>
      </Card>

      <div className="mt-4 space-y-3">
        <Field label="Why is it being cancelled?">
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Select a reason…</option>
            {REASONS.map((r) => <option key={r}>{r}</option>)}
          </Select>
        </Field>
        <Field label="Note (optional)">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the office should know" />
        </Field>
      </div>

      <ErrorNote className="mt-4">{error}</ErrorNote>

      <div className="mt-6 space-y-2.5">
        <Btn variant="danger" size="lg" block disabled={busy} onClick={submit}>
          {busy ? 'Cancelling…' : 'Mark cancelled'}
        </Btn>
        <Btn variant="ghost" block onClick={() => navigate(`/field/bills/${id}`, { replace: true, state: originState(back) })}>Keep this bill open</Btn>
      </div>
    </div>
  );
}
