import { useCallback, useEffect, useState } from 'react';
import { api, getToken } from '../lib/api.js';

const IS_IMAGE = /\.(png|jpe?g|webp|gif|heic)$/i;

/* Names of every object URL minted, revoked on page unload. */
const LIVE_URLS = new Set();
const canBlob = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
function onUnload() {
  if (!canBlob) return;
  for (const u of LIVE_URLS) URL.revokeObjectURL(u);
  LIVE_URLS.clear();
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', onUnload);

/* ── shared object-URL cache ─────────────────────────────────────── */
const urlCache = new Map(); // name -> { promise, url }

/**
 * Resolve an attachment to a blob object URL: sign it (per click, so the
 * URL never goes stale), then fetch the bytes over the auth header and hand
 * back a page-local object URL. Sharing the cache means a salesman's detail
 * page that lists the same receipt twice fetches it once.
 */
async function resolveObjectUrl(name) {
  const hit = urlCache.get(name);
  if (hit) return hit.promise;
  const promise = (async () => {
    const { urls } = await api.post('/attachments/sign', { name });
    const signed = urls?.[name];
    if (!signed) throw new Error('No signed URL');
    const res = await fetch(signed, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!canBlob) throw new Error('blob URLs unavailable');
    const url = URL.createObjectURL(await res.blob());
    LIVE_URLS.add(url);
    return url;
  })();
  urlCache.set(name, { promise });
  promise.catch(() => urlCache.delete(name)); // allow retry after failure
  return promise;
}

/**
 * Inline photo for a stored attachment. Non-image files (PDFs…) keep the old
 * "View attachment" link. Images render as a lazy thumbnail that opens a
 * lightbox with the full photo on click.
 */
export default function AttachmentPhoto({ name, className = '', alt = 'Attachment' }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const [enlarged, setEnlarged] = useState(false);

  const isImage = IS_IMAGE.test(name || '');

  useEffect(() => {
    if (!isImage || !canBlob) return undefined;
    let alive = true;
    setFailed(false);
    resolveObjectUrl(name)
      .then((u) => { if (alive) setUrl(u); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [name, isImage]);

  const openLightbox = useCallback((e) => {
    if (e) e.preventDefault();
    if (url) setEnlarged(true);
  }, [url]);

  const openSignedTab = (e) => {
    if (e) e.preventDefault();
    api.post('/attachments/sign', { name })
      .then((r) => r?.urls?.[name] && window.open(r.urls[name], '_blank', 'noopener,noreferrer'))
      .catch(() => {});
  };

  // Non-image files (PDF receipts…) and environments without blob URLs
  // (tests) fall back to opening the signed file in a new tab.
  if (!isImage || !canBlob) {
    return (
      <a href="#open-attachment" onClick={openSignedTab} className="underline">
        {isImage ? 'View photo' : 'View attachment'}
      </a>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={openLightbox}
        disabled={!url}
        aria-label={alt}
        className={className || 'block'}
      >
        {failed ? (
          <span className="text-[12px] text-ink-faint underline">photo unavailable</span>
        ) : url ? (
          <img src={url} alt={alt} className="max-h-40 w-auto rounded-lg border border-line object-contain" />
        ) : (
          <span className="inline-block h-16 w-16 animate-pulse rounded-lg border border-line bg-line/40" />
        )}
      </button>

      {enlarged && url && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onClick={() => setEnlarged(false)}
        >
          <img
            src={url}
            alt={alt}
            className="max-h-[92vh] max-w-full rounded-lg object-contain shadow-raise"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            aria-label="Close"
            onClick={() => setEnlarged(false)}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-ink/60 text-[18px] text-paper hover:bg-ink/80"
          >
            ✕
          </button>
          {name && <p className="absolute bottom-4 left-0 right-0 text-center text-[12px] text-paper/80">{name}</p>}
        </div>
      )}
    </>
  );
}
