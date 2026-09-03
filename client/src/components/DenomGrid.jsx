import { cx, money } from './ui.jsx';

export const NOTES = [500, 200, 100, 50, 20, 10];
export const COINS = [20, 10, 5, 2, 1];

/** Greedy fill — how a bundle is actually made up. */
export function decompose(amount, denominations = [...NOTES, ...COINS]) {
  let left = Math.round(Number(amount) || 0);
  const out = {};
  for (const d of denominations) {
    const count = Math.floor(left / d);
    if (count > 0) { out[d] = count; left -= count * d; }
  }
  return out;
}

export function totalOf(counts) {
  return Object.entries(counts).reduce((a, [d, c]) => a + Number(d) * Number(c || 0), 0);
}

function Tile({ denom, count, onChange, tone }) {
  const set = (n) => onChange(Math.max(0, Math.min(9999, n)));
  return (
    <div className={cx(
      'min-w-0 rounded-lg border p-2 transition-colors',
      count > 0 ? 'border-ink/30 bg-paper' : 'border-line bg-surface',
    )}
    >
      <div className="flex items-baseline justify-between gap-1">
        <span className={cx('num shrink-0 text-[15px] font-medium', tone === 'coin' ? 'text-ink-soft' : 'text-ink')}>
          ₹{denom}
        </span>
        {count > 0 && (
          <span className="num min-w-0 truncate text-right text-[11px] text-ink-soft">{money(denom * count)}</span>
        )}
      </div>
      <div className="mt-1.5 flex items-stretch overflow-hidden rounded-md border border-line">
        <button
          type="button"
          className="h-11 w-10 shrink-0 text-lg leading-none text-ink-soft hover:bg-paper hover:text-ink active:bg-paper disabled:opacity-30 touch-target no-select"
          onClick={() => set(count - 1)}
          disabled={!count}
          aria-label={`One fewer ${denom} ${tone}`}
        >
          −
        </button>
        <input
          className="num h-11 min-w-0 flex-1 border-x border-line bg-surface text-center text-[14.5px] focus:bg-paper focus:outline-none"
          value={count || ''}
          inputMode="numeric"
          placeholder="0"
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, '');
            set(raw === '' ? 0 : Number(raw));
          }}
          aria-label={`Number of ${denom} ${tone}s`}
        />
        <button
          type="button"
          className="h-11 w-10 shrink-0 text-lg leading-none text-ink-soft hover:bg-paper hover:text-ink active:bg-paper touch-target no-select"
          onClick={() => set((count || 0) + 1)}
          aria-label={`One more ${denom} ${tone}`}
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * Counting a cash bundle the way it is actually counted — one tap target per
 * note value, running total above.
 */
export default function DenomGrid({ counts, onChange, className = '' }) {
  return (
    <div className={className}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {NOTES.map((d) => (
          <Tile key={`n${d}`} denom={d} tone="note" count={counts[d] || 0} onChange={(n) => onChange({ ...counts, [d]: n })} />
        ))}
      </div>
      <p className="mb-1.5 mt-3 text-[11.5px] font-medium uppercase tracking-wider text-ink-faint">Coins</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {COINS.map((d) => (
          <Tile key={`c${d}`} denom={d} tone="coin" count={counts[d] || 0} onChange={(n) => onChange({ ...counts, [d]: n })} />
        ))}
      </div>
    </div>
  );
}
