import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useToast } from '../../lib/context.jsx';
import { money, dateLabel } from '../../lib/format.js';
import { api } from '../../lib/api.js';
import {
  Btn, Card, ErrorNote, Loading, Money, ResponsiveTable, SectionTitle, col,
} from '../../components/ui.jsx';

const TIER_LABEL = {
  exact: 'UTR exact',
  contains: 'UTR in narration',
  likely: 'Amount + date',
};

/**
 * Office bank-statement reconciliation: upload a statement (CSV/XLSX), the
 * server extracts incoming credits and matches them against the UTRs recorded
 * on online/cheque collections. The office ticks the rows to verify, Confirm
 * records them — re-uploading the same statement never double-records.
 */
export default function BankRecon() {
  useTitle('Bank reconciliation');
  const toast = useToast();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [ticked, setTicked] = useState({});
  const [recording, setRecording] = useState(false);
  const [doneMsg, setDoneMsg] = useState(null);

  const existing = useApi('/admin/bank/matches', [doneMsg]);

  const tickable = useMemo(
    () => (preview?.rows || []).filter((r) => r.matched),
    [preview],
  );
  const tickedCount = tickable.filter((r) => ticked[r.collection.id]).length;

  async function onUpload(file) {
    if (!file) return;
    setBusy(true); setError(null); setPreview(null); setDoneMsg(null); setTicked({});
    try {
      const fd = new FormData();
      fd.append('file', file);
      const out = await api.upload('/admin/bank/preview', fd);
      setPreview(out);
      // Auto-tick the safe tiers; amount+date guesses stay manual.
      const pre = {};
      for (const r of out.rows) if (r.matched && r.tier !== 'likely') pre[r.collection.id] = true;
      setTicked(pre);
      toast(`Statement read: ${out.summary.credits} credits, ${out.summary.exact + out.summary.contains} UTR matches, ${out.summary.likely} to review.`, 'success');
    } catch (e) {
      setError(e.message || 'Could not read that statement.');
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    if (!preview || tickedCount === 0) return;
    setRecording(true);
    try {
      const matches = preview.rows
        .filter((r) => r.matched && ticked[r.collection.id])
        .map((r) => ({
          confirmed: true,
          collection: { id: r.collection.id },
          amount: r.amount,
          date: r.date,
          ref: r.ref,
          tier: r.tier,
        }));
      const out = await api.post('/admin/bank/confirm', { file: preview.file, matches });
      setDoneMsg(`${out.recorded} payment${out.recorded === 1 ? '' : 's'} verified against the bank.`);
      setPreview(null);
      if (fileRef.current) fileRef.current.value = '';
      toast(doneMsg || 'Recorded.', 'success');
    } catch (e) {
      setError(e.message || 'Could not record the matches.');
    } finally {
      setRecording(false);
    }
  }

  if (existing.loading) return <Loading label="Loading bank matches…" />;
  if (existing.error) return <ErrorNote>{existing.error.message}</ErrorNote>;

  return (
    <div className="space-y-6">
      <Card className="p-4 sm:p-5">
        <SectionTitle hint="Match money received against the UTRs salesmen recorded">
          Bank statement import
        </SectionTitle>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
          Upload the day's bank statement (.csv or .xlsx). Incoming credits are matched to recorded
          online/cheque collections by UTR — exact first, then UTR-inside-narration; same amount +
          date without a UTR is flagged for your review, never auto-claimed.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => onUpload(e.target.files?.[0])}
          />
          <Btn onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? 'Reading…' : 'Choose statement…'}
          </Btn>
          {preview && (
            <Btn variant="ghost" onClick={() => { setPreview(null); setTicked({}); if (fileRef.current) fileRef.current.value = ''; }}>
              Clear
            </Btn>
          )}
        </div>
        {error && <ErrorNote className="mt-3">{error}</ErrorNote>}
        {doneMsg && (
          <p className="mt-3 rounded-lg border border-line bg-paper/60 px-3 py-2 text-[12.5px] text-settled">
            ✓ {doneMsg}
          </p>
        )}
      </Card>

      {preview && (
        <Card className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionTitle hint={preview.file}>Preview — tick what to verify</SectionTitle>
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-ink-faint">
                {tickedCount} of {tickable.length} matched ticked · credits {money(preview.summary.credit_total)}
              </span>
              <Btn size="sm" onClick={onConfirm} disabled={recording || tickedCount === 0}>
                {recording ? 'Recording…' : `Confirm ${tickedCount || ''}`}
              </Btn>
            </div>
          </div>
          <div className="mt-3">
            <ResponsiveTable
              cols={[
                col('Tick', (r) => (r.matched ? (
                  <input
                    type="checkbox"
                    aria-label={`Verify ${r.ref || 'row'}`}
                    checked={Boolean(ticked[r.collection.id])}
                    onChange={(e) => setTicked((t) => ({ ...t, [r.collection.id]: e.target.checked }))}
                    className="h-4 w-4"
                  />
                ) : <span className="text-ink-faint">—</span>), null, 'top'),
                col('Date', (r) => (r.date ? dateLabel(r.date) : '—'), null, 'top'),
                col('Narration', (r) => (
                  <span className="block max-w-[220px] truncate" title={r.narration}>{r.narration || '—'}</span>
                ), null, 'top'),
                col('UTR', (r) => r.ref || '—', null, 'top'),
                col('Credit', (r) => <Money value={r.amount} />, 'right', 'grid'),
                col('Match', (r) => (r.matched ? (
                  <span className={r.amount_ok ? 'text-settled' : 'text-attention'}>
                    {TIER_LABEL[r.tier]}
                    {!r.amount_ok && <span className="block text-[11px]">amount differs</span>}
                  </span>
                ) : <span className="text-ink-faint">No match</span>), null, 'grid'),
                col('Against', (r) => (r.collection ? (
                  <span>
                    <span className="num">{r.collection.invoice_no}</span>
                    <span className="block text-[11px] text-ink-faint">{r.collection.shop_name} · {r.collection.salesman_name}</span>
                  </span>
                ) : '—'), null, 'grid'),
              ]}
              rows={preview.rows.map((r, i) => ({ key: i, ...r }))}
            />
          </div>
        </Card>
      )}

      <div>
        <SectionTitle hint="Collections whose money is confirmed received">
          Verified payments {existing.data?.matches?.length ? `(${existing.data.matches.length})` : ''}
        </SectionTitle>
        {existing.data?.matches?.length ? (
          <ResponsiveTable
            cols={[
              col('Verified', (m) => dateLabel(String(m.created_at).slice(0, 10)), null, 'top'),
              col('Invoice', (m) => <span className="num">{m.invoice_no}</span>, null, 'top'),
              col('Shop', (m) => m.shop_name, null, 'top'),
              col('Mode', (m) => m.mode, null, 'grid'),
              col('UTR', (m) => m.ref_no || m.stmt_ref || '—', null, 'grid'),
              col('Statement', (m) => <span className="block max-w-[180px] truncate" title={m.statement_file}>{m.statement_file}</span>, null, 'grid'),
              col('Amount', (m) => <Money value={m.stmt_amount} />, 'right', 'grid'),
            ]}
            rows={existing.data.matches}
          />
        ) : (
          <p className="rounded-xl border border-line bg-paper/60 px-3.5 py-3 text-[12.5px] text-ink-soft">
            Nothing verified yet — upload a statement above.{' '}
            <Link to="/admin" className="underline underline-offset-4">Reconciliation</Link> shows the collection side.
          </p>
        )}
      </div>
    </div>
  );
}
