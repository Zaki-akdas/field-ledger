const inr = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

const inr2 = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

export function money(n) {
  return inr.format(Math.round((Number(n) || 0) * 100) / 100);
}

export function money2(n) {
  return inr2.format(Math.round((Number(n) || 0) * 100) / 100);
}

/** Compact form for hero numbers: ₹1,84,000 (no paise). */
export function rupees(n) {
  return `₹${money(n)}`;
}

export function rupees2(n) {
  return `₹${money2(n)}`;
}

export function signed(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const sign = v < 0 ? '−' : v > 0 ? '+' : '';
  return `${sign}₹${money(Math.abs(v))}`;
}

export function dayLabel(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  const today = todayISO();
  const yesterday = shiftISO(today, -1);
  if (iso === today) return 'Today';
  if (iso === yesterday) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });
}

export function dateLabel(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function todayISO() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function shiftISO(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function timeLabel(stamp) {
  if (!stamp) return '';
  const s = String(stamp).replace('T', ' ').slice(0, 19);
  const m = s.match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

export function relativeTime(stamp) {
  if (!stamp) return '';
  const then = new Date(String(stamp).replace(' ', 'T') + (String(stamp).includes('Z') ? '' : 'Z'));
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (Number.isNaN(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export const MODE_LABEL = {
  cash: 'Cash',
  online: 'Online',
  cheque: 'Cheque',
  credit_note: 'Credit note',
};

export const STATUS_LABEL = {
  pending: 'Pending',
  partial: 'Part collected',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};
