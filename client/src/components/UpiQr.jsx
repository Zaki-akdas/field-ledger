import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';

/** Fetched once per session — the payee never changes mid-day. */
let configPromise = null;
function upiConfig() {
  if (!configPromise) configPromise = api.get('/upi').catch(() => ({ enabled: false }));
  return configPromise;
}

/** The standard UPI deep link every Indian payment app understands. */
function payUri({ vpa, name, amount, note }) {
  const params = new URLSearchParams({ pa: vpa, cu: 'INR' });
  if (name) params.set('pn', name);
  if (amount > 0) params.set('am', amount.toFixed(2));
  if (note) params.set('tn', note.slice(0, 50));
  return `upi://pay?${params.toString()}`;
}

/**
 * Scannable UPI QR for the Collect screen's Online card: the shop scans it
 * with any payment app and the online half lands in the company account with
 * the invoice number riding along as the payment note. Rendered from a PNG
 * data URL (no canvas) so it also works when the phone is offline.
 *
 * Hidden entirely until the office sets UPI_VPA (+ optionally
 * UPI_PAYEE_NAME) on the server — the payee must never be guessed.
 */
export default function UpiQr({ amount = 0, note = '', className = '' }) {
  const [cfg, setCfg] = useState(null);
  const [qr, setQr] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    upiConfig().then((c) => { if (alive) setCfg(c); });
    return () => { alive = false; };
  }, []);

  const uri = useMemo(
    () => (cfg?.enabled && cfg.vpa ? payUri({ vpa: cfg.vpa, name: cfg.name, amount, note }) : null),
    [cfg, amount, note],
  );

  useEffect(() => {
    if (!uri) { setQr(null); return undefined; }
    let alive = true;
    import('qrcode')
      .then((m) => m.default.toDataURL(uri, { margin: 1, width: 336, errorCorrectionLevel: 'M' }))
      .then((url) => { if (alive) { setQr(url); setFailed(false); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [uri]);

  if (!cfg || failed || !uri || !qr) return null;

  return (
    <div className={`anim-scale flex items-center gap-3.5 rounded-lg border border-line bg-paper p-3 ${className}`}>
      <a href={uri} aria-label="Open a UPI app to pay" className="anim-press shrink-0">
        <img
          src={qr}
          data-upi-uri={uri}
          alt={`UPI QR code for ${cfg.vpa}`}
          className="h-[132px] w-[132px] rounded-md border border-line"
          width={132}
          height={132}
        />
      </a>
      <div className="min-w-0">
        <p className="text-[13.5px] font-semibold tracking-tight">Scan to pay online</p>
        <p className="mt-1 text-[12px] leading-snug text-ink-soft">
          Point any UPI app at this code — the bill number rides along with the payment.
        </p>
        <p className="num mt-2 truncate text-[11.5px] text-ink-faint" title={cfg.vpa}>{cfg.vpa}</p>
        <p className="mt-1 text-[11.5px] text-ink-faint">Tap the code to open a UPI app instead.</p>
      </div>
    </div>
  );
}
