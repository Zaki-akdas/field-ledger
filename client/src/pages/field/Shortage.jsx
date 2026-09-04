import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useApi, useTitle, newId } from '../../lib/hooks.js';
import { useSync, useToast } from '../../lib/context.jsx';
import { money, money2 } from '../../lib/format.js';
import { originOf, originState } from '../../lib/fieldBack.js';
import { Btn, Card, ErrorNote, Field, Input, Loading, Select, cx } from '../../components/ui.jsx';
import { FieldHeader } from '../../components/FieldLayout.jsx';

const REASONS = [
  'Damaged in transit',
  'Short dispatched from godown',
  'Leakage in packaging',
  'Near-expiry stock rejected',
  'Weight mismatch at delivery',
  'Item missing from crate',
  'Other',
];

const blankItem = () => ({ product: '', qty: '', rate: '', reason: '' });

export default function Shortage() {
  const { id } = useParams();
  useTitle('Report shortage');
  const navigate = useNavigate();
  const location = useLocation();
  const back = originOf(location);
  const { push } = useToast();
  const { save } = useSync();
  const { data, loading } = useApi(`/bills/${id}`);
  const products = useApi('/products');
  const [items, setItems] = useState([blankItem()]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const bill = data?.bill;
  const total = items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);

  const update = (idx, patch) => setItems((list) => list.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const pickProduct = (idx, name) => {
    const match = (products.data?.products || []).find((p) => p.name === name);
    update(idx, { product: name, rate: match ? String(match.default_rate) : '' });
  };

  const submit = async () => {
    const filled = items.filter((i) => i.product.trim());
    if (filled.length === 0) { setError('Name the product that came up short.'); return; }
    for (const i of filled) {
      if (!Number(i.qty) || Number(i.qty) <= 0) { setError(`Enter a quantity for ${i.product}.`); return; }
      if (!i.reason) { setError(`Say why ${i.product} was short.`); return; }
    }
    setError(null);
    setBusy(true);
    try {
      const result = await save({
        type: 'short-items',
        payload: {
          bill_id: Number(id),
          items: filled.map((i) => ({
            product: i.product.trim(), qty: Number(i.qty), rate: Number(i.rate) || 0, reason: i.reason,
          })),
          client_id: newId(),
        },
        label: `Shortage · ${bill?.invoice_no} · ₹${money(total)}`,
      });
      push(result.queued
        ? 'No signal — shortage saved on this phone. It will sync on its own.'
        : `Shortage reported — ₹${money(total)} off ${bill?.invoice_no}.`, 'success');
      navigate(`/field/bills/${id}`, { replace: true, state: originState(back) });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading label="Opening bill…" />;
  if (!bill) return <div className="py-10"><ErrorNote>Bill not found.</ErrorNote></div>;

  return (
    <div className="pb-36">
      <FieldHeader title={bill ? `Report shortage · ${bill.invoice_no}` : 'Report shortage'} back={`/field/bills/${id}`} backState={back ? { back } : undefined} />

      <Card className="p-4">
        <p className="num text-[13.5px] text-ink-soft">{bill.invoice_no} · {bill.shop_name}</p>
        <p className="mt-2 text-[13px] text-ink-soft">
          Short items are deducted from what you’re expected to collect on this bill.
        </p>
      </Card>

      <div className="mt-4 space-y-3">
        {items.map((item, idx) => (
          <Card key={idx} className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[12px] font-semibold uppercase tracking-wider text-ink-faint">Item {idx + 1}</p>
              {items.length > 1 && (
                <button
                  type="button"
                  onClick={() => setItems((l) => l.filter((_, i) => i !== idx))}
                  className="text-[12.5px] text-attention underline"
                >
                  Remove
                </button>
              )}
            </div>
            <div className="space-y-3">
              <Field label="Product">
                <Input
                  list="product-list"
                  value={item.product}
                  onChange={(e) => update(idx, { product: e.target.value })}
                  onBlur={(e) => pickProduct(idx, e.target.value)}
                  placeholder="Start typing a product name"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Quantity">
                  <Input mono inputMode="decimal" value={item.qty} onChange={(e) => update(idx, { qty: e.target.value })} placeholder="0" />
                </Field>
                <Field label="Rate">
                  <Input mono inputMode="decimal" value={item.rate} onChange={(e) => update(idx, { rate: e.target.value })} placeholder="0" />
                </Field>
              </div>
              <Field label="Reason">
                <Select value={item.reason} onChange={(e) => update(idx, { reason: e.target.value })}>
                  <option value="">Select a reason…</option>
                  {REASONS.map((r) => <option key={r}>{r}</option>)}
                </Select>
              </Field>
              {(Number(item.qty) || 0) > 0 && (
                <p className="text-right text-[13px] text-ink-soft">
                  Amount <span className="num text-[15px] font-medium">₹{money2((Number(item.qty) || 0) * (Number(item.rate) || 0))}</span>
                </p>
              )}
            </div>
          </Card>
        ))}

        <datalist id="product-list">
          {(products.data?.products || []).map((p) => <option key={p.id} value={p.name} />)}
        </datalist>

        <Btn variant="secondary" block onClick={() => setItems((l) => [...l, blankItem()])}>
          Add another item
        </Btn>
      </div>

      <ErrorNote className="mt-4">{error}</ErrorNote>

      <div className="fixed inset-x-0 bottom-[max(56px,calc(48px+env(safe-area-inset-bottom)))] z-30 border-t border-line bg-surface/95 backdrop-blur safe-bottom">
        <div className="mx-auto max-w-[560px] px-4 py-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[12.5px] text-ink-soft">Total shortage</span>
            <span className={cx('num text-[20px] font-medium', total > 0 && 'text-attention')}>₹{money2(total)}</span>
          </div>
          <Btn variant="danger" size="lg" block disabled={busy || total <= 0} onClick={submit}>
            {busy ? 'Saving…' : `Report shortage · ₹${money(total)}`}
          </Btn>
        </div>
      </div>
    </div>
  );
}
