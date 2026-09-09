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

  /**
   * WhatsApp share: the shop's chat opens with the payment details pre-filled.
   * WhatsApp doesn't hyperlink upi:// scheme URIs, so the message carries what
   * the shop actually needs to pay from any app — the payee VPA, the exact
   * amount, and the invoice note — plus a nudge to scan the QR screen-to-screen.
   */
  const shareText = [
    `Payment request${amount > 0 ? ` of ₹${amount.toFixed(2)}` : ''}${note ? ` for invoice ${note}` : ''} —`,
    `pay via UPI to ${cfg.vpa}${cfg.name ? ` (${cfg.name})` : ''}.`,
    `Or scan the QR code on the screen.`,
  ].join(' ');
  const waHref = `https://wa.me/?text=${encodeURIComponent(shareText)}`;

  return (
    <div className={`anim-scale flex flex-col items-center gap-3.5 rounded-lg border border-line bg-paper p-3 sm:flex-row sm:items-center ${className}`}>
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
      <div className="min-w-0 text-center sm:text-left">
        <p className="text-[13.5px] font-semibold tracking-tight">Scan to pay online</p>
        <p className="mt-1 text-[12px] leading-snug text-ink-soft">
          Point any UPI app at this code — the bill number rides along with the payment.
        </p>
        <p className="num mt-2 truncate text-[11.5px] text-ink-faint" title={cfg.vpa}>{cfg.vpa}</p>
        <div className="mt-1.5 flex items-center gap-2">
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            data-wa-share={shareText}
            aria-label="Send the payment request to the shop on WhatsApp"
            className="anim-press inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[11.5px] font-medium text-ink-soft transition-colors hover:border-ink-soft"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.87 9.87 0 0 0 4.79 1.22h.01c5.46 0 9.9-4.45 9.9-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.15h-.01a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.82 2.42a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.23-8.24 8.23Zm4.52-6.16c-.25-.13-1.47-.72-1.69-.8-.23-.09-.4-.13-.56.12-.17.25-.64.8-.78.97-.15.16-.29.18-.54.06-.25-.13-1.05-.39-2-1.23-.73-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.51.11-.11.25-.29.37-.43.13-.15.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.13-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.13.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.6.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.07-.1-.23-.16-.48-.29Z"/>
            </svg>
            Share on WhatsApp
          </a>
        </div>
      </div>
    </div>
  );
}
