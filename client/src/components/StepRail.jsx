import { cx } from './ui.jsx';

/**
 * A numbered step sequence. Used for exactly one thing in this product —
 * Start day → Visit shop → Collect → End day — and nowhere else.
 */
export default function StepRail({ steps, current, onStep, className = '' }) {
  return (
    <ol className={cx('flex items-start', className)}>
      {steps.map((step, i) => {
        const index = i + 1;
        const done = index < current;
        const active = index === current;
        const clickable = Boolean(onStep && step.to && index <= current);
        const Tag = clickable ? 'button' : 'div';
        return (
          <li key={step.label} className="flex-1 min-w-0">
            <Tag
              {...(clickable ? { type: 'button', onClick: () => onStep(step.to) } : {})}
              className={cx('block w-full text-left', clickable && 'cursor-pointer')}
            >
              <div className="flex items-center">
                <span
                  className={cx(
                    'num flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[12px] font-medium',
                    done && 'border-settled bg-settled text-white',
                    active && 'border-ink bg-ink text-paper',
                    !done && !active && 'border-line bg-surface text-ink-faint',
                  )}
                >
                  {done ? '✓' : index}
                </span>
                {i < steps.length - 1 && (
                  <span className={cx('mx-1.5 h-px flex-1', index < current ? 'bg-settled/50' : 'bg-line')} />
                )}
              </div>
              <span
                className={cx(
                  'mt-1.5 block text-[10px] leading-tight sm:pr-1 sm:text-[11.5px]',
                  active ? 'font-medium text-ink' : done ? 'text-settled-deep' : 'text-ink-faint',
                )}
              >
                {step.label}
              </span>
            </Tag>
          </li>
        );
      })}
    </ol>
  );
}
