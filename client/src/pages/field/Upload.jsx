import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTitle, downloadTemplate, fileToCompressedDataUrl, newId } from '../../lib/hooks.js';
import { useSync, useToast } from '../../lib/context.jsx';
import { api } from '../../lib/api.js';
import { todayISO, money } from '../../lib/format.js';
import {
  Btn, Card, ErrorNote, Field, Input, SectionTitle, Segmented, Spinner,
} from '../../components/ui.jsx';
import { FieldHeader, QueuedList } from '../../components/FieldLayout.jsx';

export default function Upload() {
  useTitle('Add bills');
  const navigate = useNavigate();
  const { push } = useToast();
  const { online, save } = useSync();
  const fileRef = useRef(null);
  const [mode, setMode] = useState('batch');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);

  const [single, setSingle] = useState({
    invoice_no: '', shop_name: '', area: '', amount: '', bill_date: todayISO(), file: null,
  });

  const runUpload = async (file) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const data = await api.upload(`/bills/upload?bill_date=${single.bill_date}`, fd);
      setResult(data);
      push(`${data.created} ${data.created === 1 ? 'bill' : 'bills'} added — ₹${money(data.total_amount)} on the route.`, 'success');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submitSingle = async () => {
    setError(null);
    if (!single.invoice_no.trim()) { setError('Enter the invoice number.'); return; }
    if (!single.shop_name.trim()) { setError('Enter the customer or shop name.'); return; }
    if (!Number(single.amount) || Number(single.amount) <= 0) { setError('Enter a bill amount greater than zero.'); return; }
    setBusy(true);
    try {
      const extra = single.file
        ? (online
          ? await (async () => {
            const fd = new FormData(); fd.append('file', single.file);
            const r = await api.upload('/attachments', fd);
            return { attachment: r.path };
          })()
          : { attachment_data: await fileToCompressedDataUrl(single.file) })
        : {};

      const res = await save({
        type: 'bill',
        payload: {
          invoice_no: single.invoice_no.trim(),
          shop_name: single.shop_name.trim(),
          area: single.area.trim(),
          amount: Number(single.amount),
          bill_date: single.bill_date,
          client_id: newId(),
          ...extra,
        },
        label: `Bill · ${single.invoice_no.trim()} · ₹${money(Number(single.amount))}`,
      });
      push(res.queued
        ? 'No signal — bill saved on this phone. It will sync on its own.'
        : `Bill ${single.invoice_no.trim()} added.`, 'success');
      setSingle({ invoice_no: '', shop_name: '', area: '', amount: '', bill_date: single.bill_date, file: null });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-10">
      <FieldHeader title="Add bills" back="/field/bills" />

      <Segmented
        className="mb-4"
        value={mode}
        onChange={setMode}
        options={[{ value: 'batch', label: 'Batch upload' }, { value: 'single', label: 'One bill' }]}
      />

      {mode === 'batch' ? (
        <>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); runUpload(e.dataTransfer.files?.[0]); }}
            className={`rounded-xl border-2 border-dashed px-5 py-8 text-center transition-colors ${
              dragging ? 'border-ink bg-paper' : 'border-line-strong bg-surface'
            }`}
          >
            <p className="text-[15px] font-medium">Drop today’s dispatch sheet here</p>
            <p className="mt-1 text-[13px] text-ink-soft">Excel, CSV or a CO-SHIP PDF, up to 12 MB</p>
            <div className="mt-4 flex justify-center gap-2">
              <Btn variant="primary" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
                {busy ? <Spinner /> : null} Choose file
              </Btn>
              <Btn size="sm" onClick={downloadTemplate}>Get the template</Btn>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv,.pdf"
              className="hidden"
              onChange={(e) => runUpload(e.target.files?.[0])}
            />
          </div>

          <div className="mt-4 rounded-xl border border-line bg-surface p-4">
            <p className="text-[12.5px] font-medium uppercase tracking-wider text-ink-faint">Columns we look for</p>
            <p className="num mt-2 text-[13px] text-ink-soft">Invoice No · Customer · Area · Amount · Date</p>
            <p className="mt-1.5 text-[12.5px] text-ink-faint">
              Column order and header wording don’t matter — we match on the header text.
              Drop a CO-SHIP PDF print-out and we read its rows directly.
            </p>
          </div>

          {result && (
            <div className="mt-4">
              <SectionTitle hint={`₹${money(result.total_amount)} added to the route`}>
                {result.created} {result.created === 1 ? 'bill' : 'bills'} added
              </SectionTitle>
              {result.skipped.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-line bg-surface">
                  <p className="border-b border-line bg-attention-tint px-3.5 py-2 text-[12.5px] font-medium text-attention-deep">
                    {result.skipped.length} {result.skipped.length === 1 ? 'row needs' : 'rows need'} a look
                  </p>
                  <table className="table-dense">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Invoice</th>
                        <th>Why</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.skipped.slice(0, 30).map((s, i) => (
                        <tr key={i}>
                          <td className="num">{s.row}</td>
                          <td className="num">{s.invoice_no || '—'}</td>
                          <td className="text-ink-soft">{s.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Btn className="mt-3" block onClick={() => navigate('/field/bills')}>Go to bills</Btn>
            </div>
          )}
        </>
      ) : (
        <Card className="p-4 space-y-3">
          <Field label="Invoice number">
            <Input mono value={single.invoice_no} onChange={(e) => setSingle({ ...single, invoice_no: e.target.value })} placeholder="INV/2026/00353" />
          </Field>
          <Field label="Customer / shop name">
            <Input value={single.shop_name} onChange={(e) => setSingle({ ...single, shop_name: e.target.value })} placeholder="Sharma General Store" />
          </Field>
          <Field label="Area (optional)">
            <Input value={single.area} onChange={(e) => setSingle({ ...single, area: e.target.value })} placeholder="Vijay Nagar" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount">
              <Input mono inputMode="decimal" value={single.amount} onChange={(e) => setSingle({ ...single, amount: e.target.value })} placeholder="0" />
            </Field>
            <Field label="Bill date">
              <Input type="date" mono value={single.bill_date} onChange={(e) => setSingle({ ...single, bill_date: e.target.value })} />
            </Field>
          </div>
          <Field label="Photo of the bill (optional)" hint={online ? 'Useful when the invoice number is hard to read.' : 'Photos attach after sync if there’s no signal.'}>
            <input
              type="file"
              accept="image/*,application/pdf"
              className="block w-full text-[13px] text-ink-soft file:mr-3 file:rounded-md file:border-0 file:bg-paper file:px-3 file:py-2 file:text-[13px] file:font-medium file:text-ink"
              onChange={(e) => setSingle({ ...single, file: e.target.files?.[0] || null })}
            />
          </Field>
          <Btn variant="primary" size="lg" block disabled={busy} onClick={submitSingle}>
            {busy ? 'Saving…' : 'Add bill'}
          </Btn>
        </Card>
      )}

      <ErrorNote className="mt-4">{error}</ErrorNote>
      <QueuedList />
    </div>
  );
}
