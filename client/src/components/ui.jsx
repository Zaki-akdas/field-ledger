import { money, money2 } from '../lib/format.js';

export { money, money2 };
import { useBodyScrollLock, useEscape } from '../lib/hooks.js';

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

/* ---------------------------------------------------------------- numbers --- */

export function Money({ value, paise = false, className = '', prefix = true }) {
  return (
    <span className={cx('num', className)}>
      {prefix ? '₹' : ''}
      {paise ? money2(value) : money(value)}
    </span>
  );
}

export function Variance({ value, className = '' }) {
  const v = Math.round((Number(value) || 0) * 100) / 100;
  const tone = Math.abs(v) < 1 ? 'text-ink-soft' : v > 0 ? 'text-attention' : 'text-settled';
  return (
    <span className={cx('num', tone, className)}>
      {v < 0 ? '−' : ''}₹{money(Math.abs(v))}
    </span>
  );
}

/* ------------------------------------------------------------------ pills --- */

const PILL_TONES = {
  settled: 'bg-settled-tint text-settled-deep border-settled/25',
  attention: 'bg-attention-tint text-attention-deep border-attention/25',
  neutral: 'bg-paper text-ink-soft border-line',
  ink: 'bg-ink text-paper border-ink',
};

export function Pill({ tone = 'neutral', children, className = '' }) {
  return (
    <span className={cx(
      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide whitespace-nowrap',
      PILL_TONES[tone] || PILL_TONES.neutral,
      className,
    )}
    >
      {children}
    </span>
  );
}

export const STATUS_TONE = {
  delivered: 'settled',
  pending: 'neutral',
  partial: 'attention',
  cancelled: 'attention',
};

export function StatusPill({ status, label }) {
  return (
    <Pill tone={STATUS_TONE[status] || 'neutral'}>
      <span className={cx('h-1.5 w-1.5 rounded-full',
        status === 'delivered' ? 'bg-settled'
          : status === 'cancelled' ? 'bg-attention'
            : status === 'partial' ? 'bg-attention' : 'bg-ink-faint')}
      />
      {label}
    </Pill>
  );
}

/* ---------------------------------------------------------------- buttons --- */

const BTN = {
  primary: 'bg-ink text-paper border-ink hover:bg-[#22304a] active:bg-[#121a26]',
  settled: 'bg-settled text-white border-settled hover:bg-settled-deep',
  danger: 'bg-attention text-white border-attention hover:bg-attention-deep',
  secondary: 'bg-surface text-ink border-line hover:border-line-strong hover:bg-paper',
  ghost: 'bg-transparent text-ink-soft border-transparent hover:bg-paper hover:text-ink',
  outlineDanger: 'bg-surface text-attention border-attention/40 hover:bg-attention-tint',
};

export function Btn({
  children, variant = 'secondary', size = 'md', block = false, className = '', ...rest
}) {
  const sizes = {
    sm: 'h-10 px-3 text-[13px]',
    md: 'h-11 px-4 text-[15px]',
    lg: 'h-12 px-5 text-[15px]',
  };
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg border font-medium transition-colors',
        'disabled:opacity-45 disabled:cursor-not-allowed select-none',
        sizes[size], BTN[variant], block && 'w-full', className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconBtn({ label, children, className = '', ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cx('inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-soft hover:bg-paper hover:text-ink transition-colors', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------- surfaces --- */

export function Card({ children, className = '', as: As = 'div', ...rest }) {
  return <As className={cx('panel', className)} {...rest}>{children}</As>;
}

export function SectionTitle({ children, hint, right, className = '' }) {
  return (
    <div className={cx('flex items-end justify-between gap-3 mb-2', className)}>
      <div>
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-ink-soft">{children}</h2>
        {hint && <p className="text-[12px] text-ink-faint mt-0.5">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

export function Field({ label, hint, error, children, className = '' }) {
  return (
    <div className={className}>
      {label && <label className="label">{label}</label>}
      {children}
      {error ? <p className="mt-1.5 text-[12.5px] text-attention">{error}</p>
        : hint ? <p className="mt-1.5 text-[12.5px] text-ink-faint">{hint}</p> : null}
    </div>
  );
}

export function Input({ className = '', mono = false, invalid = false, ...rest }) {
  return (
    <input
      className={cx('input', mono && 'input-mono', invalid && 'border-attention focus:border-attention', className)}
      {...rest}
    />
  );
}

export function Select({ className = '', children, ...rest }) {
  return (
    <select className={cx('input pr-8 appearance-none bg-[length:16px] bg-no-repeat bg-[right_0.75rem_center]', className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2364748B' stroke-width='2'><path d='M6 9l6 6 6-6'/></svg>\")" }}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Textarea({ className = '', ...rest }) {
  return <textarea className={cx('input h-20 py-2.5 resize-none', className)} {...rest} />;
}

/* ------------------------------------------------------------ stepper etc. --- */

export function Spinner({ className = '' }) {
  return (
    <span className={cx('inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-ink-soft', className)} />
  );
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-faint">
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({ title, body, action, icon }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface/60 px-6 py-10 text-center">
      {icon && <div className="mb-3 text-2xl text-ink-faint">{icon}</div>}
      <p className="text-[15px] font-medium text-ink">{title}</p>
      {body && <p className="mt-1 text-[13.5px] text-ink-soft">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children, className = '' }) {
  if (!children) return null;
  return (
    <div className={cx('rounded-lg border border-attention/35 bg-attention-tint px-3.5 py-2.5 text-[13.5px] text-attention-deep', className)}>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- filters --- */

export function Segmented({ options, value, onChange, className = '' }) {
  return (
    <div className={cx('flex w-full rounded-lg border border-line bg-surface p-0.5 sm:w-auto sm:inline-flex', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex-1 whitespace-nowrap rounded-md px-3 py-2.5 min-h-[40px] text-center text-[13px] font-medium transition-colors active:scale-[0.98] sm:flex-none sm:py-1.5 sm:min-h-0',
            value === o.value ? 'bg-ink text-paper' : 'text-ink-soft hover:bg-paper hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chips({ options, value, onChange, className = '' }) {
  return (
    <div className={cx('flex gap-1.5 overflow-x-auto no-scrollbar snap-x-scroll contain-scroll', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            'snap-start shrink-0 rounded-full border px-3 py-2 min-h-[36px] text-[12.5px] font-medium transition-colors active:scale-[0.97]',
            value === o.value
              ? 'border-ink bg-ink text-paper'
              : 'border-line bg-surface text-ink-soft hover:border-line-strong',
          )}
        >
          {o.label}
          {o.count != null && <span className="num ml-1.5 opacity-70">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ sheet --- */

export function Sheet({ open, onClose, title, children, footer }) {
  useEscape(onClose, open);
  useBodyScrollLock(open);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative max-h-[88vh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface p-5 pb-5 safe-bottom shadow-raise sm:max-w-md sm:rounded-2xl"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong sm:hidden" />
        {title && <h3 className="text-[17px] font-semibold mb-3">{title}</h3>}
        {children}
        {footer && <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- misc --- */

export function KeyValue({ label, value, tone = '', className = '' }) {
  return (
    <div className={cx('flex items-baseline justify-between gap-4 py-1.5', className)}>
      <dt className="text-[13.5px] text-ink-soft">{label}</dt>
      <dd className={cx('num text-[14.5px]', tone)}>{value}</dd>
    </div>
  );
}

export function ProgressBar({ value, max, tone = 'settled' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
      <div
        className={cx('h-full rounded-full transition-[width] duration-300', tone === 'settled' ? 'bg-settled' : 'bg-attention')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------- mobile stacked cards ---
 *
 * ResponsiveTable renders a real <table> from md: up, but below 480px it
 * hides the table and stacks each row as a labelled card instead — so phone
 * users read records vertically and never scroll a wide table sideways.
 *
 * col(label, cell, align?, spawn?) declares where a column lands in the
 * mobile card: spawn 'top' = primary line, 'mid' = second line under it,
 * 'grid' = labelled stat at the card's top right, undefined = footer chips.
 */
const SPAWN_POS = ['top', 'mid', 'grid'];
export const col = (label, cell, align, spawn, header) => ({ label, cell, align, spawn, header });

export function ResponsiveTable({ cols, rows, footer, empty, className = '', rowProps, cardProps, tableWrapProps }) {
  const isSpawn = (c) => SPAWN_POS.includes(c.spawn);
  const primary = cols.find(isSpawn);
  const mids = cols.filter((c) => c.spawn === 'mid');
  const stats = cols.filter((c) => c.spawn === 'grid');
  const rest = cols.filter((c) => !isSpawn(c));
  const keyOf = (r, i) => (r && (r.id ?? r.key)) ?? i;

  const CardRow = ({ r, i }) => (
    <div
      className="rounded-xl border border-line bg-surface p-3.5 shadow-panel"
      {...(cardProps ? cardProps(r, i) : {})}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {primary && <div className="min-w-0">{primary.cell(r, i)}</div>}
          {mids.map((c) => (
            <div key={c.label} className="mt-1 min-w-0 text-[12px] text-ink-soft">{c.cell(r, i)}</div>
          ))}
        </div>
        {stats.length > 0 && (
          <div className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-1">
            {stats.map((c) => (
              <div key={c.label}>
                <p className="text-[10.5px] uppercase tracking-wider text-ink-faint">{c.label}</p>
                <div className="num text-right text-[13px]">{c.cell(r, i)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      {rest.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2.5">
          {rest.map((c) => {
            const cell = c.cell(r, i);
            // Skip placeholder chips so cards stay tight when a field is empty.
            if (cell == null || cell === '—' || cell === '') return null;
            return (
              <span key={c.label} className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-soft">
                <span className="shrink-0 text-ink-faint">{c.label}</span>
                <span className="min-w-0 truncate">{cell}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* Phone: stacked cards. */}
      <div className={cx('space-y-2.5 md:hidden', className)}>
        {rows.length === 0 && empty}
        {rows.map((r, i) => (
          <div key={keyOf(r, i)} {...(rowProps ? rowProps(r, i) : {})}>
            <CardRow r={r} i={i} />
          </div>
        ))}
        {footer && <div className="pt-1">{footer}</div>}
      </div>
      {/* md+: the table. */}
      <TableWrap className={cx(tableWrapProps?.className, 'hidden md:block')} {...tableWrapProps}>
        <thead>
          <tr>{cols.map((c) => <Th key={c.label} align={c.align}>{c.header ? c.header() : c.label}</Th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={keyOf(r, i)} {...(rowProps ? rowProps(r, i) : {})}>
              {cols.map((c) => <Td key={c.label} align={c.align}>{c.cell(r, i)}</Td>)}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><Td colSpan={cols.length} className="py-10 text-center text-ink-faint">{empty}</Td></tr>
          )}
          {footer && <tr><Td colSpan={cols.length}>{footer}</Td></tr>}
        </tbody>
      </TableWrap>
    </>
  );
}

export function TableWrap({ children, className = '' }) {
  return (
    <div className={cx('overflow-x-auto rounded-xl border border-line bg-surface contain-scroll', className)}>
      <table className="table-dense min-w-[480px]">{children}</table>
    </div>
  );
}

export function Th({ children, className = '', align = 'left' }) {
  return (
    <th className={cx(align === 'right' && 'text-right', align === 'center' && 'text-center', className)}>{children}</th>
  );
}

export function Td({ children, className = '', align = 'left' }) {
  return (
    <td className={cx(align === 'right' && 'text-right', align === 'center' && 'text-center', className)}>{children}</td>
  );
}


