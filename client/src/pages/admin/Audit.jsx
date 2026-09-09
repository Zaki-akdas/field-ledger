import { useState } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { dateLabel, timeLabel } from '../../lib/format.js';
import {
  Chips, EmptyState, ErrorNote, Loading, Pill, ResponsiveTable, col,
} from '../../components/ui.jsx';

const ACTION_LABEL = {
  delete: 'Deleted',
  purge: 'Hard deleted',
  restore: 'Restored',
  trash_purge: 'Erased from bin',
  trash_sweep: 'Auto-wiped (expired)',
  factory_reset: 'Factory reset',
};
const ACTION_TONE = {
  delete: 'neutral',
  purge: 'attention',
  restore: 'settled',
  trash_purge: 'attention',
  trash_sweep: 'neutral',
  factory_reset: 'attention',
};
const ENTITY_LABEL = { bill: 'Bill', shop: 'Shop', salesman: 'Salesman', trash: 'Trash', system: 'System' };

const ACTIONS = [
  { value: 'all', label: 'All' },
  { value: 'delete', label: 'Deletes' },
  { value: 'purge', label: 'Hard deletes' },
  { value: 'restore', label: 'Restores' },
  { value: 'trash_purge', label: 'Bin erases' },
];

/** Best-effort human summary of the details JSONB bag. */
function detailLine(d) {
  if (!d) return null;
  const parts = [];
  if (d.amount != null) parts.push(<span key="a">₹<span className="num">{Number(d.amount).toLocaleString('en-IN')}</span></span>);
  if (d.bills_removed != null) parts.push(<span key="b" className="num">{d.bills_removed} bill{d.bills_removed === 1 ? '' : 's'}</span>);
  if (d.shop_removed) parts.push(<span key="c">shop also removed</span>);
  if (d.swept != null) parts.push(<span key="d" className="num">{d.swept}</span>);
  if (d.restorable_until) parts.push(<span key="e">restorable until {dateLabel(String(d.restorable_until).slice(0, 10))}</span>);
  return parts.length ? parts.map((p, i) => <span key={i} className="inline-flex items-center gap-1">{i > 0 && <span className="text-ink-faint">·</span>}{p}</span>) : null;
}

export default function Audit() {
  useTitle('Audit log');
  const [action, setAction] = useState('all');
  const qs = action === 'all' ? '' : `?action=${action}`;
  const { data, loading, error } = useApi(`/admin/audit${qs}`);
  const entries = data?.entries || [];

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <p className="text-[13px] text-ink-soft">
          Every delete, hard delete, restore, and wipe — <span className="num font-medium">{data?.total ?? '…'}</span> recorded.
          Append-only: entries can never be edited or removed.
        </p>
      </div>

      <Chips
        className="mb-3"
        value={action}
        onChange={setAction}
        options={ACTIONS.map((a) => ({ ...a, count: undefined }))}
      />

      {loading ? <Loading label="Loading the log…" /> : error ? <ErrorNote>{error.message}</ErrorNote> : entries.length === 0 ? (
        <EmptyState
          icon="📜"
          title="Nothing recorded yet"
          body="Deletes, restores and purges will appear here with who did them and when."
        />
      ) : (
        <ResponsiveTable
          className="max-h-[70vh] overflow-y-auto"
          cols={[
            col('When', (e) => (
              <span>
                <span className="block whitespace-nowrap text-[13px]">{dateLabel(String(e.created_at).slice(0, 10))}</span>
                <span className="num block whitespace-nowrap text-[11.5px] text-ink-faint">{timeLabel(e.created_at)}</span>
              </span>
            ), null, 'top'),
            col('Action', (e) => (
              <Pill tone={ACTION_TONE[e.action] || 'neutral'}>{ACTION_LABEL[e.action] || e.action}</Pill>
            ), null, 'mid'),
            col('What', (e) => (
              <span>
                <span className="block text-[13.5px] font-medium">{e.label || '—'}</span>
                <span className="text-[11.5px] text-ink-faint">
                  {ENTITY_LABEL[e.entity] || e.entity}
                  {e.entity_id != null && <span className="num"> #{e.entity_id}</span>}
                  {detailLine(e.details) && <span className="ml-1.5 inline-flex items-center gap-1 text-ink-soft">· {detailLine(e.details)}</span>}
                </span>
              </span>
            )),
            col('By', (e) => (
              <span className="whitespace-nowrap">
                {e.actor_code && <span className="num mr-1.5 text-[11.5px] text-ink-faint">{e.actor_code}</span>}
                {e.actor_name}
              </span>
            )),
          ]}
          rows={entries}
          empty={<p className="py-10 text-center text-ink-faint">No entries for this filter.</p>}
        />
      )}
    </div>
  );
}
