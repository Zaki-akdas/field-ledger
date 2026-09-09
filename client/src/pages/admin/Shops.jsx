import { useMemo, useState } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useToast } from '../../lib/context.jsx';
import { api } from '../../lib/api.js';
import { money } from '../../lib/format.js';
import {
  Btn, ErrorNote, Input, Loading, Money, PurgeSheet, ResponsiveTable, col,
} from '../../components/ui.jsx';

export default function Shops() {
  useTitle('Shops');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [purging, setPurging] = useState(null);
  const [purgeBusy, setPurgeBusy] = useState(false);
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
  const allVisible = shops.length > 0 && shops.every((s) => selected.has(s.id));
  const toggleAll = (e) => {
    e.stopPropagation();
    setSelected(allVisible ? new Set() : new Set(shops.map((s) => s.id)));
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

  /* ---- single hard delete ---- */
  const handlePurge = async (password) => {
    setPurgeBusy(true);
    try {
      const r = await api.post(`/admin/shops/${purging.id}/purge`, { password });
      push(`Hard-deleted ${purging.name}${r.bills_removed ? ` and its ${r.bills_removed} bill${r.bills_removed > 1 ? 's' : ''}` : ''}. Restorable from Trash for 30 days.`, 'success');
      setPurging(null);
      reload();
    } catch (err) {
      push(err.message, 'error');
      throw err;
    } finally {
      setPurgeBusy(false);
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
          ), 'center', 'grid', () => (
            <label className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={allVisible} onChange={toggleAll} className="h-4 w-4 cursor-pointer accent-red-500" aria-label="Select all" />
            </label>
          )),
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
          col('Actions', (s) => (
            <span className="flex items-center gap-1">
              <Btn
                size="sm"
                variant="ghost"
                className="text-red-500 hover:text-red-700"
                aria-label={`Delete ${s.name}`}
                onClick={(e) => { e.stopPropagation(); handleDelete(s, e); }}
                disabled={busy}
              >
                Delete
              </Btn>
              <Btn
                size="sm"
                variant="ghost"
                className="text-red-600 hover:text-red-800"
                aria-label={`Hard delete ${s.name}`}
                onClick={(e) => { e.stopPropagation(); setPurging(s); }}
                disabled={busy}
              >
                Hard delete
              </Btn>
            </span>
          )),
        ]}
        rows={shops}
        empty={<p className="py-10 text-center text-ink-faint">No shops match these filters.</p>}
      />

      <PurgeSheet
        open={!!purging}
        onClose={() => setPurging(null)}
        title={`Hard delete ${purging?.name || ''}?`}
        description={purging ? `Shop ${purging.name} and every bill ever raised against it (${purging.bill_count || 0} bill${purging.bill_count === 1 ? '' : 's'}, ₹${money(purging.billed || 0)}) are removed permanently — collections, shortages and history included.` : ''}
        onConfirm={handlePurge}
        busy={purgeBusy}
      />
    </div>
  );
}
