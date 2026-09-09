import { useState } from 'react';
import { useApi, useTitle } from '../../lib/hooks.js';
import { useToast } from '../../lib/context.jsx';
import { api } from '../../lib/api.js';
import { dateLabel } from '../../lib/format.js';
import {
  Btn, Card, EmptyState, ErrorNote, Loading, Pill, RefreshButton, SectionTitle,
} from '../../components/ui.jsx';

const ENTITY_LABEL = { bill: 'Bill', shop: 'Shop', salesman: 'Salesman' };
const ENTITY_TONE = { bill: 'neutral', shop: 'ink', salesman: 'attention' };

/** Days left before this entry auto-wipes, rounded. */
function daysLeft(expiresAt) {
  const ms = new Date(expiresAt.replace(' ', 'T')).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export default function Trash() {
  useTitle('Trash');
  const { push } = useToast();
  const [busy, setBusy] = useState(null); // trash id currently being acted on
  const { data, loading, error, reload } = useApi('/admin/trash');
  const entries = data?.entries || [];

  const act = async (id, fn, okMsg) => {
    setBusy(id);
    try {
      await fn();
      push(okMsg, 'success');
      reload();
    } catch (err) {
      push(err.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const restore = (e) => act(e.id,
    () => api.post(`/admin/trash/${e.id}/restore`, {}),
    `${ENTITY_LABEL[e.entity]} restored — ${e.label} is back in the ledger.`);

  const purge = (e) => {
    if (!window.confirm(`Erase "${e.label}" from the bin for good? After this it can never be restored.`)) return;
    act(e.id, () => api.post(`/admin/trash/${e.id}/purge`, {}), `Erased ${e.label} permanently.`);
  };

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <p className="text-[13px] text-ink-soft">
          Hard-deleted records live here for <span className="num font-medium">30 days</span> and can be
          put back exactly as they were. After 30 days they wipe automatically.
        </p>
        <div className="flex items-center gap-2">
          {data?.swept > 0 && (
            <Pill tone="neutral"><span className="num">{data.swept}</span> expired &amp; swept</Pill>
          )}
          <RefreshButton label="Refresh trash" />
        </div>
      </div>

      {loading ? <Loading label="Opening the bin…" /> : error ? <ErrorNote>{error.message}</ErrorNote> : entries.length === 0 ? (
        <EmptyState
          icon="🗑"
          title="The bin is empty"
          body="Hard deletes from Bills, Shops and Salesmen wait here for 30 days before auto-wiping."
        />
      ) : (
        <div className="space-y-2.5">
          <SectionTitle hint={`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} restorable`}>
            In the bin
          </SectionTitle>
          {entries.map((e) => {
            const left = daysLeft(e.expires_at);
            const urgent = left <= 5;
            return (
              <Card key={e.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={ENTITY_TONE[e.entity] || 'neutral'}>{ENTITY_LABEL[e.entity] || e.entity}</Pill>
                      <p className="text-[14.5px] font-medium">{e.label}</p>
                    </div>
                    <p className="mt-1 text-[12.5px] text-ink-faint">
                      Deleted {dateLabel(String(e.deleted_at).slice(0, 10))} by {e.deleted_by_name || '—'}
                      {e.bill_count > 0 && <> · <span className="num">{e.bill_count}</span> bill{e.bill_count === 1 ? '' : 's'} inside</>}
                    </p>
                    <p className={`num mt-0.5 text-[12.5px] ${urgent ? 'font-medium text-attention' : 'text-ink-soft'}`}>
                      {urgent ? '⚠ ' : ''}Restorable for {left} more {left === 1 ? 'day' : 'days'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Btn size="sm" onClick={() => restore(e)} disabled={busy === e.id}>Restore</Btn>
                    <Btn size="sm" variant="outlineDanger" onClick={() => purge(e)} disabled={busy === e.id}>
                      Erase forever
                    </Btn>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
