import { useCallback, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Anchor to a stored attachment (invoice photo / collection screenshot).
 * /uploads/:file is not public: bytes are only served with a short-lived
 * HMAC signature, minted by the API for the logged-in user. A fresh URL is
 * fetched on every click, so links never go stale while a page sits open.
 */
export default function AttachmentLink({ name, children, className = '', ...rest }) {
  const [busy, setBusy] = useState(false);

  const open = useCallback(async (e) => {
    e.preventDefault();
    if (!name || busy) return;
    setBusy(true);
    try {
      const r = await api.post('/attachments/sign', { name });
      const signed = r?.urls?.[name];
      if (signed) window.open(signed, '_blank', 'noopener,noreferrer');
    } catch {
      // Signature request failed (offline / expired session) — nothing to open.
    } finally {
      setBusy(false);
    }
  }, [name, busy]);

  return (
    <a
      href="#open-attachment"
      onClick={open}
      aria-disabled={busy ? 'true' : undefined}
      className={className}
      {...rest}
    >
      {children}
    </a>
  );
}
