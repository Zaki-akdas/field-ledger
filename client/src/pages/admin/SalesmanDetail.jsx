import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { adminBackLabel, adminOriginOf } from '../../lib/adminBack.js';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useRange } from '../../components/AdminLayout.jsx';
import { money, dateLabel, MODE_LABEL, STATUS_LABEL } from '../../lib/format.js';
import {
  Card, ErrorNote, Loading, Money, Pill, SectionTitle, TableWrap, Td, Th, Variance, cx,
} from '../../components/ui.jsx';
import AttachmentPhoto from '../../components/AttachmentPhoto.jsx';

const TONE = { delivered: 'settled', partial: 'attention', pending: 'neutral', cancelled: 'attention' };

export default function SalesmanDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { from: rangeFrom, to: rangeTo } = useRange();
  const from = params.get('from') || rangeFrom;
  const to = params.get('to') || rangeTo;
  useTitle('Salesman');
  const navigate = useNavigate();
  const location = useLocation();
  const backTo = adminOriginOf(location);
  const goBack = () => {
    // Back returns to the page the admin tapped from (state.back, legacy
    // ?back= as fallback), carrying the drill-down's range along, and
    // replaces history so the browser Back button can't re-enter the detail.
    const q = new URLSearchParams(location.search);
    q.delete('back');
    const search = q.toString();
    navigate(`${backTo || '/admin/salesmen'}${search ? `?${search}` : ''}`, { replace: true });
  };
  const { data, loading, error } = useApi(`/admin/salesmen/${id}?from=${from}&to=${to}`);

  if (loading) return <Loading label="Opening salesman…" />;
  if (error) return <ErrorNote>{error.message}</ErrorNote>;

  const r = data.reconciliation;
  const s = data.salesman;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="num text-[12.5px] text-ink-faint">{s.code}</p>
          <h2 className="text-[22px] font-semibold leading-tight tracking-tight sm:text-[24px]">{s.name}</h2>
          <p className="text-[13px] text-ink-soft">{s.phone}</p>
        </div>
        <button type="button" onClick={goBack} className="text-[13px] font-medium text-ink underline underline-offset-4">
          ← {adminBackLabel(backTo) || 'All salesmen'}
        </button>
      </div>

      <Card className="grid grid-cols-1 gap-0 divide-y sm:grid-cols-3 sm:divide-y-0 sm:divide-x divide-line">
        {[
          { label: 'Expected', value: <Money value={r.expected} />, sub: `${money(r.billed)} billed − ${money(r.cancelled_amount)} cancelled − ${money(r.short_amount)} short` },
          { label: 'Collected', value: <Money value={r.actual} />, sub: `Cash ${money(r.by_mode.cash)} · online ${money(r.by_mode.online)} · cheque ${money(r.by_mode.cheque)} · CN ${money(r.by_mode.credit_note)}`, tone: 'text-settled' },
          { label: 'Variance', value: <Variance value={r.variance} />, sub: `${r.bill_count} bills · ${r.cancelled_count} cancelled`, tone: Math.abs(r.variance) < 1 ? 'text-settled' : 'text-attention' },
        ].map((h) => (
          <div key={h.label} className="px-4 py-3.5 sm:px-5 sm:py-4">
            <p className="text-[11.5px] font-medium uppercase tracking-[0.12em] text-ink-faint">{h.label}</p>
            <p className={cx('num mt-1.5 text-[22px] leading-none font-medium sm:text-[28px]', h.tone)}>{h.value}</p>
            <p className="num mt-2 text-[11.5px] leading-relaxed sm:text-[12px] text-ink-faint">{h.sub}</p>
          </div>
        ))}
      </Card>

      <div>
        <SectionTitle hint={`${data.bills.length} bills`}>Bills on the route</SectionTitle>
        <TableWrap className="max-h-[420px] overflow-y-auto">
          <thead>
            <tr>
              <Th>Invoice</Th>
              <Th className="hidden lg:table-cell">Date</Th>
              <Th>Shop</Th>
              <Th align="right">Amount</Th>
              <Th align="right" className="hidden xl:table-cell">Short</Th>
              <Th align="right" className="hidden md:table-cell">Collected</Th>
              <Th align="right">Balance</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {data.bills.map((b) => (
              <tr key={b.id}>
                <Td className="num whitespace-nowrap">{b.invoice_no}</Td>
                <Td className="num hidden whitespace-nowrap text-ink-soft lg:table-cell">{dateLabel(b.bill_date)}</Td>
                <Td className="max-w-[220px] truncate">{b.shop_name}</Td>
                <Td align="right" className="num"><Money value={b.amount} /></Td>
                <Td align="right" className="num hidden xl:table-cell">{b.short_amount > 0 ? <span className="text-attention"><Money value={b.short_amount} /></span> : <span className="text-ink-faint">—</span>}</Td>
                <Td align="right" className="num hidden md:table-cell"><Money value={b.collected_amount} /></Td>
                <Td align="right" className="num"><Money value={b.balance} /></Td>
                <Td><Pill tone={TONE[b.status]}>{STATUS_LABEL[b.status]}</Pill></Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </div>

      <div>
        <SectionTitle hint={`${data.collections.length} entries`}>Collection entries</SectionTitle>
        <TableWrap className="max-h-[420px] overflow-y-auto">
          <thead>
            <tr>
              <Th className="hidden lg:table-cell">Date</Th>
              <Th>Invoice</Th>
              <Th>Mode</Th>
              <Th>Reference</Th>
              <Th className="hidden xl:table-cell">Note</Th>
              <Th align="right">Amount</Th>
            </tr>
          </thead>
          <tbody>
            {data.collections.map((c) => (
              <tr key={c.id}>
                <Td className="num hidden whitespace-nowrap text-ink-soft lg:table-cell">{dateLabel(c.collection_date)}</Td>
                <Td className="num whitespace-nowrap">{c.invoice_no}</Td>
                <Td>{MODE_LABEL[c.mode]}</Td>
                <Td className="num whitespace-nowrap text-ink-soft">{c.ref_no || '—'}</Td>
                <Td className="hidden text-ink-soft xl:table-cell">
                  {c.note && <span>{c.note}</span>}
                  {c.attachment && (
                    <span className="mt-1 block">
                      <AttachmentPhoto name={c.attachment} alt={`${MODE_LABEL[c.mode] || 'Collection'} photo ${c.invoice_no || ''}`.trim()} />
                    </span>
                  )}
                </Td>
                <Td align="right" className="num"><Money value={c.amount} /></Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <SectionTitle hint={`${data.cancellations.length} bills · ₹${money(data.cancellations.reduce((a, c) => a + c.amount, 0))}`}>
            Cancellations
          </SectionTitle>
          {data.cancellations.length === 0 ? (
            <Card className="p-5 text-[13.5px] text-ink-faint">Nothing cancelled in this period.</Card>
          ) : (
            <TableWrap>
              <thead>
                <tr><Th>Invoice</Th><Th className="hidden sm:table-cell">Shop</Th><Th align="right">Amount</Th><Th>Reason</Th></tr>
              </thead>
              <tbody>
                {data.cancellations.map((c) => (
                  <tr key={c.id}>
                    <Td className="num">{c.invoice_no}</Td>
                    <Td className="hidden max-w-[160px] truncate sm:table-cell">{c.shop_name}</Td>
                    <Td align="right" className="num text-attention"><Money value={c.amount} /></Td>
                    <Td className="text-ink-soft">{c.reason}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </div>

        <div>
          <SectionTitle hint={`${data.shortages.length} lines · ₹${money(data.shortages.reduce((a, c) => a + c.amount, 0))}`}>
            Shortages
          </SectionTitle>
          {data.shortages.length === 0 ? (
            <Card className="p-5 text-[13.5px] text-ink-faint">No short items reported in this period.</Card>
          ) : (
            <TableWrap>
              <thead>
                <tr><Th>Product</Th><Th align="right">Qty</Th><Th align="right">Amount</Th><Th className="hidden sm:table-cell">Reason</Th></tr>
              </thead>
              <tbody>
                {data.shortages.map((s) => (
                  <tr key={s.id}>
                    <Td className="max-w-[170px] truncate">{s.product}</Td>
                    <Td align="right" className="num">{s.qty}</Td>
                    <Td align="right" className="num text-attention"><Money value={s.amount} /></Td>
                    <Td className="hidden max-w-[150px] truncate text-ink-soft sm:table-cell">{s.reason}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </div>
      </div>

      {data.sessions.length > 0 && (
        <div>
          <SectionTitle>Day log</SectionTitle>
          <Card className="divide-y divide-line">
            {data.sessions.map((sess) => (
              <div key={sess.id} className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 text-[13.5px]">
                <span className="num">{dateLabel(sess.work_date)}</span>
                <span className="num text-ink-soft">
                  {sess.started_at ? String(sess.started_at).slice(11, 16) : '—'} → {sess.ended_at ? String(sess.ended_at).slice(11, 16) : 'open'}
                </span>
                {sess.closing_note && <span className="text-ink-soft">{sess.closing_note}</span>}
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}
