import { useRef, useState } from 'react';
import { useApi, useTitle, downloadTemplate } from '../../lib/hooks.js';
import { api } from '../../lib/api.js';
import { todayISO, money } from '../../lib/format.js';
import {
  Btn, Card, ErrorNote, Field, Input, SectionTitle, Select, Spinner, TableWrap, Td, Th,
} from '../../components/ui.jsx';

export default function Upload() {
  useTitle('Upload bills');
  const people = useApi('/salesmen');
  const fileRef = useRef(null);
  const [salesmanId, setSalesmanId] = useState('');
  const [billDate, setBillDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);

  const run = async (file) => {
    if (!file) return;
    if (!salesmanId) { setError('Choose which salesman this batch belongs to.'); return; }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('salesman_id', salesmanId);
      const data = await api.upload(`/bills/upload?bill_date=${billDate}`, fd);
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="max-w-3xl">
      <Card className="p-4 sm:p-5">
        <div className="grid gap-3 sm:gap-4 sm:grid-cols-2">
          <Field label="Assign to salesman">
            <Select value={salesmanId} onChange={(e) => setSalesmanId(e.target.value)}>
              <option value="">Select salesman…</option>
              {(people.data?.salesmen || []).map((s) => (
                <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Bill date" hint="Used for rows without a date column.">
            <Input type="date" mono value={billDate} onChange={(e) => setBillDate(e.target.value)} />
          </Field>
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); run(e.dataTransfer.files?.[0]); }}
          className={`mt-4 rounded-xl border-2 border-dashed px-5 py-10 text-center transition-colors ${
            dragging ? 'border-ink bg-paper' : 'border-line-strong bg-surface'
          }`}
        >
          <p className="text-[15px] font-medium">Drop the dispatch sheet here</p>
          <p className="mt-1 text-[13px] text-ink-soft">Excel or CSV · Invoice No, Customer, Area, Amount, Date</p>
          <div className="mt-4 flex justify-center gap-2">
            <Btn variant="primary" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? <Spinner /> : null} Choose file
            </Btn>
            <Btn size="sm" onClick={downloadTemplate}>Get the template</Btn>
          </div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => run(e.target.files?.[0])} />
        </div>
      </Card>

      <ErrorNote className="mt-4">{error}</ErrorNote>

      {result && (
        <div className="mt-5">
          <SectionTitle hint={`₹${money(result.total_amount)} added to the selected route`}>
            {result.created} {result.created === 1 ? 'bill' : 'bills'} added
          </SectionTitle>
          {result.skipped.length > 0 && (
            <TableWrap>
              <thead>
                <tr><Th>Row</Th><Th>Invoice</Th><Th>Why it was skipped</Th></tr>
              </thead>
              <tbody>
                {result.skipped.slice(0, 40).map((s, i) => (
                  <tr key={i}>
                    <Td className="num">{s.row}</Td>
                    <Td className="num">{s.invoice_no || '—'}</Td>
                    <Td className="text-ink-soft">{s.reason}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
          {result.bills.length > 0 && (
            <TableWrap className="mt-4 max-h-[360px] overflow-y-auto">
              <thead>
                <tr><Th>Invoice</Th><Th>Customer</Th><Th align="right">Amount</Th></tr>
              </thead>
              <tbody>
                {result.bills.slice(0, 40).map((b) => (
                  <tr key={b.id}>
                    <Td className="num">{b.invoice_no}</Td>
                    <Td>{b.shop_name}</Td>
                    <Td align="right" className="num">₹{money(b.amount)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </div>
      )}
    </div>
  );
}
