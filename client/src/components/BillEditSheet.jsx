import { useEffect, useState } from 'react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { money } from '../lib/format.js';
import { Btn, ErrorNote, Field, Input, Select } from './ui.jsx';
import { Sheet } from './ui.jsx';

/**
 * Office form for correcting a bill and its shop card: invoice number,
 * amount, date, route, and the shop's name/contact details. Every change
 * is audited server-side; money is guarded there too (never below what has
 * already been collected, never onto a duplicate invoice).
 */
export default function BillEditSheet({ bill, onClose, onSaved }) {
  const people = useApi('/salesmen');
  const history = useApi(bill ? `/bills/${bill.id}` : null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (bill) {
      setForm({
        invoice_no: bill.invoice_no,
        amount: String(bill.amount),
        bill_date: bill.bill_date,
        salesman_id: String(bill.salesman_id),
        shop_name: bill.shop_name || '',
        shop_area: bill.shop_area || '',
        shop_owner: bill.shop_owner || '',
        shop_phone: bill.shop_phone || '',
      });
      setError(null);
    }
  }, [bill]);

  if (!bill || !form) return null;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setError(null);
    const amt = Number(form.amount);
    if (!form.invoice_no.trim()) return setError('Invoice number cannot be empty.');
    if (!Number.isFinite(amt) || amt <= 0) return setError('Enter a bill amount greater than zero.');
    if ((bill.collected_amount || 0) > 0 && amt < bill.collected_amount) {
      return setError(`₹${money(bill.collected_amount)} is already collected — the amount cannot go below that.`);
    }
    setBusy(true);
    try {
      const body = {
        bill: {
          invoice_no: form.invoice_no.trim(),
          amount: amt,
          bill_date: form.bill_date,
          salesman_id: Number(form.salesman_id),
        },
        shop: {
          name: form.shop_name.trim(),
          area: form.shop_area.trim(),
          owner_name: form.shop_owner.trim(),
          phone: form.shop_phone.trim(),
        },
      };
      const r = await api.patch(`/bills/${bill.id}`, body);
      onSaved(r.bill, r.changed || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Edit ${bill.invoice_no}`}
      footer={(
        <>
          <Btn variant="secondary" block onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn variant="primary" block disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</Btn>
        </>
      )}
    >
      <div className="space-y-3.5">
        {(bill.collected_amount || 0) > 0 && (
          <p className="num rounded-lg bg-paper px-3 py-2 text-[12.5px] text-ink-soft">
            ₹{money(bill.collected_amount)} already collected against this bill.
          </p>
        )}

        <p className="text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">Bill</p>
        <Field label="Invoice number">
          <Input mono value={form.invoice_no} onChange={set('invoice_no')} autoCapitalize="characters" />
        </Field>
        <Field label="Amount (₹)">
          <Input mono inputMode="decimal" value={form.amount} onChange={set('amount')} placeholder="0" />
        </Field>
        <Field label="Bill date">
          <Input type="date" mono value={form.bill_date} onChange={set('bill_date')} />
        </Field>
        <Field label="Salesman / route">
          <Select value={form.salesman_id} onChange={set('salesman_id')}>
            {(people.data?.salesmen || []).map((s) => (
              <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
            ))}
          </Select>
        </Field>

        <p className="pt-1 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">Shop card</p>
        <Field label="Shop name">
          <Input value={form.shop_name} onChange={set('shop_name')} />
        </Field>
        <Field label="Area">
          <Input value={form.shop_area} onChange={set('shop_area')} placeholder="—" />
        </Field>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Owner">
            <Input value={form.shop_owner} onChange={set('shop_owner')} placeholder="—" />
          </Field>
          <Field label="Phone">
            <Input mono inputMode="tel" value={form.shop_phone} onChange={set('shop_phone')} placeholder="—" />
          </Field>
        </div>

        <p className="text-[12px] leading-snug text-ink-faint">
          Every change is recorded with who made it and what it was — the salesman sees the same history on the bill.
        </p>
        <ErrorNote>{error}</ErrorNote>

        {(history.data?.edits?.length || 0) > 0 && (
          <div className="border-t border-line pt-3">
            <p className="text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">
              Recent changes · {history.data.edits.length}
            </p>
            <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto pr-1">
              {history.data.edits.slice(0, 10).map((e) => (
                <p key={e.id} className="text-[12px] leading-snug text-ink-soft">
                  <span className="font-medium">{e.field.replace(/_/g, ' ')}</span> · {e.old_value || '—'} → {e.new_value || '—'}
                  <span className="text-ink-faint"> · {e.edited_by_name}</span>
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
