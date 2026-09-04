import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useAuth, useToast } from '../../lib/context.jsx';
import { api } from '../../lib/api.js';
import { money, MODE_LABEL, dateLabel } from '../../lib/format.js';
import { backLabel, originOf, originState } from '../../lib/fieldBack.js';
import {
  Btn, Card, ErrorNote, KeyValue, Loading, Money, Pill, SectionTitle, Sheet, StatusPill,
} from '../../components/ui.jsx';
import AttachmentPhoto from '../../components/AttachmentPhoto.jsx';
import { FieldHeader } from '../../components/FieldLayout.jsx';

export default function BillDetail() {
  const { id } = useParams();
  useTitle('Bill');
  const navigate = useNavigate();
  const location = useLocation();
  // The tab the salesman tapped this bill open from — Bills list, Collect
  // list, or My numbers — so Back returns there instead of a fixed page.
  // Carried in router state (not the URL); a ?back= from older builds still
  // works via originOf's fallback.
  const back = originOf(location);
  const { push } = useToast();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const { data, loading, error, reload } = useApi(`/bills/${id}`);

  const bill = data?.bill;
  const balance = bill ? bill.expected_amount - bill.collected_amount : 0;

  const undoCancel = async () => {
    setBusy(true);
    try {
      await api.del(`/cancellations/${bill.id}`);
      push('Cancellation reversed. The bill is open again.', 'success');
      setConfirmUndo(false);
      reload();
    } catch (err) {
      push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading label="Opening bill…" />;
  if (error || !bill) return <div className="py-10"><ErrorNote>{error?.message || 'Bill not found.'}</ErrorNote></div>;

  return (
    <div>
      <FieldHeader title={back ? `Bill · opened from ${backLabel(back)}` : 'Bill'} back={back ?? '/field/bills'} backState={back ? { back } : undefined} />

      <Card className="p-4">
        <p className="num text-[15.5px] font-medium">{bill.invoice_no}</p>
        <h2 className="mt-0.5 text-[19px] font-semibold leading-tight tracking-tight">{bill.shop_name}</h2>
        <p className="mt-0.5 text-[13px] text-ink-soft">
          {[bill.shop_area, bill.shop_owner && `Owner: ${bill.shop_owner}`].filter(Boolean).join(' · ')}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusPill status={bill.status} label={{
            pending: 'Pending', partial: 'Part collected', delivered: 'Delivered', cancelled: 'Cancelled',
          }[bill.status]} />
          <Pill tone="neutral">{dateLabel(bill.bill_date)}</Pill>
        </div>
      </Card>

      {bill.cancelled_at && (
        <div className="mt-4 rounded-xl border border-attention/30 bg-attention-tint p-4">
          <p className="text-[13px] font-semibold uppercase tracking-wider text-attention-deep">Cancelled</p>
          <p className="mt-1 text-[14px] text-ink">{data.cancellation?.reason}</p>
          <p className="num mt-1 text-[13px] text-ink-soft">
            ₹{money(data.cancellation?.amount || bill.amount)} · {dateLabel(data.cancellation?.cancel_date)}
            {data.cancellation?.salesman_id === user?.id ? '' : ` · ${bill.salesman_name}`}
          </p>
          <Btn variant="outlineDanger" size="sm" className="mt-3" onClick={() => setConfirmUndo(true)}>
            Undo cancellation
          </Btn>
        </div>
      )}

      <Card className="mt-4 p-4">
        <dl className="divide-y divide-line">
          <KeyValue label="Bill amount" value={`₹${money(bill.amount)}`} />
          {(bill.short_amount || 0) > 0 && (
            <KeyValue label="Less: short items" value={`−₹${money(bill.short_amount)}`} tone="text-attention" />
          )}
          <KeyValue label="Expected" value={`₹${money(bill.expected_amount)}`} className="font-medium" tone="text-ink font-semibold" />
          <KeyValue label="Collected" value={`₹${money(bill.collected_amount)}`} tone={(bill.collected_amount || 0) > 0 ? 'text-settled' : 'text-ink-faint'} />
          <KeyValue
            label={balance > 0.5 ? 'Still to collect' : balance < -0.5 ? 'Over-collected' : 'Balance'}
            value={`₹${money(Math.abs(balance))}`}
            tone={balance > 0.5 ? 'text-attention' : balance < -0.5 ? 'text-ink' : 'text-settled'}
            className="font-medium"
          />
        </dl>
      </Card>

      {data.collections?.length > 0 && (
        <div className="mt-6">
          <SectionTitle hint={`${data.collections.length} ${data.collections.length === 1 ? 'entry' : 'entries'}`}>
            Collected
          </SectionTitle>
          <div className="overflow-hidden rounded-xl border border-line bg-surface divide-y divide-line">
            {data.collections.map((c) => (
              <div key={c.id} className="flex items-start justify-between gap-3 px-3.5 py-3">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium">{MODE_LABEL[c.mode]}</p>
                  {c.ref_no && <p className="num truncate text-[12px] text-ink-faint">{c.ref_no}</p>}
                  {c.note && <p className="text-[12px] text-ink-soft">{c.note}</p>}
                  {c.bank && <p className="text-[12px] text-ink-soft">{c.bank}{c.cheque_date ? ` · ${dateLabel(c.cheque_date)}` : ''}</p>}
                  {c.attachment && (
                    <div className="mt-1.5">
                      <AttachmentPhoto
                        name={c.attachment}
                        alt={`${MODE_LABEL[c.mode] || 'Collection'} photo${c.ref_no ? ` · ${c.ref_no}` : ''}`}
                      />
                    </div>
                  )}
                </div>
                <p className="num shrink-0 text-[14.5px]">₹{money(c.amount)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.short_items?.length > 0 && (
        <div className="mt-6">
          <SectionTitle hint={`−₹${money(bill.short_amount)} off expected`}>Short items</SectionTitle>
          <div className="overflow-hidden rounded-xl border border-line bg-surface divide-y divide-line">
            {data.short_items.map((s) => (
              <div key={s.id} className="px-3.5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium">{s.product}</p>
                    <p className="num text-[12px] text-ink-faint">
                      {s.qty} × ₹{money(s.rate)} · {s.reason}
                    </p>
                  </div>
                  <p className="num shrink-0 text-[14px] text-attention">₹{money(s.amount)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!bill.cancelled_at && (
        <div className="mt-6 space-y-2.5">
          <Btn
            variant="primary"
            size="lg"
            block
            onClick={() => navigate(`/field/bills/${bill.id}/collect`, { state: originState(back) })}
          >
            {bill.collected_amount > 0 ? 'Collect the balance' : 'Deliver & collect'}
          </Btn>
          <div className="grid grid-cols-2 gap-2.5">
            <Btn size="lg" onClick={() => navigate(`/field/bills/${bill.id}/shortage`, { state: originState(back) })}>Report shortage</Btn>
            <Btn variant="outlineDanger" size="lg" onClick={() => navigate(`/field/bills/${bill.id}/cancel`, { state: originState(back) })}>
              Mark cancelled
            </Btn>
          </div>
        </div>
      )}

      <Sheet
        open={confirmUndo}
        onClose={() => setConfirmUndo(false)}
        title="Undo this cancellation?"
        footer={(
          <>
            <Btn variant="secondary" block onClick={() => setConfirmUndo(false)}>Keep cancelled</Btn>
            <Btn variant="primary" block disabled={busy} onClick={undoCancel}>Undo cancellation</Btn>
          </>
        )}
      >
        <p className="text-[14px] text-ink-soft">
          Invoice <span className="num">{bill.invoice_no}</span> goes back on the route as an open bill worth{' '}
          <Money value={bill.amount} className="font-medium" />.
        </p>
      </Sheet>
    </div>
  );
}
