import { useMemo, useState } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useToast } from '../../lib/context.jsx';
import { api } from '../../lib/api.js';
import { money } from '../../lib/format.js';
import {
  Btn, ErrorNote, Input, Loading, Money, ResponsiveTable, col,
} from '../../components/ui.jsx';

export default function Shops() {
  useTitle('Shops');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const { push } = useToast();
  const { data, loading, error, reload } = useApi('/admin/shops');

  const shops = useMemo(() => {
    const list = data?.shops || [];
    if (!q.trim()) return list;
    const n = q.toLowerCase();
    return list.filter((s) => s.name.toLowerCase().includes(n)
      || (s.area || '').toLowerCase().includes(n)
      || (s.owner_name || '').toLowerCase().includes(n)
      || (s.salesman_name || '').toLowerCase().includes(n));
  }, [data, q]);

  const total = shops.reduce((a, s) => a + (s.billed || 0), 0);

  /* ---- selection ---- */
  const toggleSelect = (id, e) => {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  /* ---- single delete ---- */
  const handleDelete = async (s, e) => {
    e.stopPropagation();
    if (!window.confirm(`Delete shop "${s.name}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.del(`/admin/shops/${s.id}`);
      push(`Deleted ${s.name}.`, 'success');
      reload();
    } catch (err) {
      push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ---- bulk delete ---- */
  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} shop${selected.size > 1 ? 's' : ''}? Shops with bills will be skipped.`)) return;
    setBusy(true);
    try {
      const r = await api.post('/admin/shops/delete', { ids: [...selected] });
      const n = r.deleted?.length || 0;
      const skip = r.skipped?.length || 0;
      push(n ? `Deleted ${n} shop${n > 1 ? 's' : ''}${skip ? `, skipped ${skip}` : ''}.` : 'Nothing was deleted.', n ? 'success' : 'error');
      setSelected(new Set());
      reload();
    } catch (err) {
      push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading label="Loading shops…" />;
  if (error) return <ErrorNote>{error.message}</ErrorNote>;

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search shop, area, owner, salesman" className="h-11 w-full min-h-[44px] sm:max-w-[280px] sm:flex-1 sm:h-9 sm:min-h-0" aria-label="Search shops" />
        <span className="text-[12.5px] text-ink-faint">
          <span className="num">{shops.length}</span> shops · ₹<span className="num">{money(total)}</span> billed
        </span>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm dark:bg-red-950/30">
          <span className="font-medium text-red-700 dark:text-red-300">{selected.size} selected</span>
          <Btn size="sm" variant="danger" onClick={handleBulkDelete} disabled={busy}>Delete selected</Btn>
          <Btn size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Btn>
        </div>
      )}

      <ResponsiveTable
        className="max-h-[70vh] overflow-y-auto"
        cols={[
          col('', (s) => (
            <input
              type="checkbox"
              checked={selected.has(s.id)}
              onChange={(e) => toggleSelect(s.id, e)}
              className="h-4 w-4 cursor-pointer accent-red-500"
              aria-label={`Select ${s.name}`}
            />
          ), 'center', 'grid'),
          col('Shop', (s) => (
            <span>
              <span className="block text-[13.5px] font-medium">{s.name}</span>
              {s.area && <span className="text-[11.5px] text-ink-faint">{s.area}</span>}
            </span>
          ), null, 'top'),
          col('Owner', (s) => s.owner_name || '—'),
          col('Phone', (s) => s.phone || '—'),
          col('Salesman', (s) => s.salesman_code ? <span><span className="num text-ink-faint">{s.salesman_code}</span> {s.salesman_name}</span> : '—'),
          col('Bills', (s) => <span className="num">{s.bill_count}</span>, 'right'),
          col('Billed', (s) => <Money value={s.billed} />, 'right'),
          col('', (s) => (
            <Btn
              size="sm"
              variant="ghost"
              className="text-red-500 hover:text-red-700"
              aria-label={`Delete ${s.name}`}
              onClick={(e) => handleDelete(s, e)}
              disabled={busy}
            >
              Delete
            </Btn>
          )),
        ]}
        rows={shops}
        empty={<p className="py-10 text-center text-ink-faint">No shops match these filters.</p>}
      />
    </div>
  );
}
