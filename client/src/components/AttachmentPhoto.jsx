import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken } from '../lib/api.js';

const IS_IMAGE = /\.(png|jpe?g|webp|gif|heic)$/i;

/* Names of every object URL we minted, revoked on page unload. */
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

/* ── page-level photo gallery ───────────────────────────────────────
 * Every image AttachmentPhoto on the page claims a slot in SLOTS at mount
 * time, so the gallery always follows visual order (a photo's bytes may
 * resolve in any order, but a slot is never reordered once claimed). Each
 * slot fills in its URL when the bytes arrive; opening any photo raises a
 * single lightbox that steps across the ready set (on-screen arrows plus
 * ← / → / Esc), so a bill carrying several collection photos is browsable
 * without closing and reopening. */
const SLOTS = []; // { id, name, alt, url } — position = mount order
let activeId = null;
let photoSeq = 0;
// One-shot guard: a drag/swipe that ends on the overlay is followed by a
// synthetic click (browsers fire click after pointerup). That click must not
// close the lightbox. Module-level because a step may hand the dialog to
// another photo's instance before the click lands — the flag has to survive
// the component swap.
let overlayClickGuard = 0;
const photoSubs = new Set();
function photoNotify() { for (const fn of photoSubs) fn(); }
const photoList = () => SLOTS.filter((s) => s.url);
function photoOpen(id) { if (id !== activeId) { activeId = id; photoNotify(); } }
function photoClose() { if (activeId !== null) { activeId = null; photoNotify(); } }
function photoStep(delta) {
  const list = photoList();
  if (activeId == null || list.length < 2) return;
  const i = list.findIndex((p) => p.id === activeId);
  if (i === -1) return;
  const next = list[(i + delta + list.length) % list.length];
  if (next && next.id !== activeId) photoOpen(next.id);
}

/**
 * Warm the object-URL cache for the photos around the one on screen. Fetching
 * is shared and idempotent (one request per file), so this only starts the
 * network load for neighbours that haven't resolved yet — the owner component
 * fills its slot and notifies when the bytes land, letting the counter and
 * arrows grow while the lightbox is already open.
 */
const PRELOAD_RADIUS = 2;
function preloadNeighbors(id) {
  const i = SLOTS.findIndex((s) => s.id === id);
  if (i === -1) return;
  for (let step = 1; step <= PRELOAD_RADIUS; step += 1) {
    const left = SLOTS[i - step];
    const right = SLOTS[i + step];
    if (left && !left.url) resolveObjectUrl(left.name).catch(() => {});
    if (right && !right.url) resolveObjectUrl(right.name).catch(() => {});
  }
}

/**
 * Inline photo for a stored attachment. Non-image files (PDFs…) keep the old
 * "View attachment" link. Images render as a lazy thumbnail that opens the
 * page gallery lightbox with the full photo on click.
 */
export default function AttachmentPhoto({ name, className = '', alt = 'Attachment' }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const [, setTick] = useState(0); // re-render when the gallery set changes
  const idRef = useRef(null);
  const imgRef = useRef(null);
  const dragRef = useRef({ pointer: null, startX: 0, startY: 0, dx: 0, swiping: false });

  const isImage = IS_IMAGE.test(name || '');

  // Claim the gallery slot once, at mount, in visual (mount) order. Releasing
  // it on unmount is the only thing that ever moves it.
  useEffect(() => {
    if (!isImage || !canBlob) return undefined;
    if (!idRef.current) idRef.current = `photo-${++photoSeq}`;
    const id = idRef.current;
    const slot = { id, name, alt, url: null };
    SLOTS.push(slot);
    const onChange = () => setTick((t) => t + 1);
    photoSubs.add(onChange);
    photoNotify(); // let the whole page see the new set/count
    return () => {
      photoSubs.delete(onChange);
      const i = SLOTS.indexOf(slot);
      if (i !== -1) SLOTS.splice(i, 1);
      if (activeId === id) activeId = null;
      photoNotify();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slot position is fixed at first mount
  }, [isImage]);

  // Keep the slot's label in sync if props ever change (never reorders).
  useEffect(() => {
    if (!isImage || !canBlob || !idRef.current) return;
    const slot = SLOTS.find((s) => s.id === idRef.current);
    if (slot) { slot.name = name; slot.alt = alt; }
  }, [isImage, name, alt]);

  // Fetch the bytes; fill the slot URL in place when they arrive.
  useEffect(() => {
    if (!isImage || !canBlob) return undefined;
    let alive = true;
    setFailed(false);
    resolveObjectUrl(name)
      .then((u) => {
        if (!alive) return;
        setUrl(u);
        const slot = SLOTS.find((s) => s.id === idRef.current);
        if (slot && slot.url !== u) { slot.url = u; photoNotify(); }
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [name, isImage]);

  const list = photoList();
  const isActive = !!idRef.current && activeId === idRef.current;
  const index = isActive ? Math.max(0, list.findIndex((p) => p.id === idRef.current)) : 0;
  const total = list.length;

  // While the lightbox is open: warm the neighbours' bytes, and handle the
  // keyboard (← / → / Esc).
  useEffect(() => {
    if (!isActive) return undefined;
    if (idRef.current) preloadNeighbors(idRef.current);
    const onKey = (e) => {
      if (e.key === 'Escape') photoClose();
      else if (e.key === 'ArrowLeft') photoStep(-1);
      else if (e.key === 'ArrowRight') photoStep(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive]);

  // Touch/mouse swipe between photos: drag the picture sideways, release past
  // a threshold to step (with the browser kept out of horizontal gestures via
  // touch-action: pan-y).
  const swipeDown = (e) => {
    if (total < 2 || !url) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const d = dragRef.current;
    d.pointer = e.pointerId;
    d.startX = e.clientX ?? 0;
    d.startY = e.clientY ?? 0;
    d.dx = 0;
    d.swiping = false;
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ok */ }
  };
  const swipeMove = (e) => {
    const d = dragRef.current;
    if (d.pointer !== e.pointerId) return;
    const dx = (e.clientX ?? d.startX) - d.startX;
    const dy = (e.clientY ?? d.startY) - d.startY;
    if (!d.swiping) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) d.swiping = true;
      else return; // vertical intent
    }
    d.dx = dx;
    if (!imgRef.current) return;
    imgRef.current.style.transition = 'none';
    imgRef.current.style.transform = `translateX(${dx}px) scale(0.98)`;
    imgRef.current.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / 900));
  };
  const swipeUp = (e) => {
    const d = dragRef.current;
    if (d.pointer !== e.pointerId) return;
    d.pointer = null;
    if (d.swiping) {
      const threshold = Math.max(60, Math.round((window.innerWidth || 360) * 0.18));
      if (Math.abs(d.dx) >= threshold) {
        // Step first, then arm the guard: the release's click must not close.
        if (d.dx < 0) photoStep(1); else photoStep(-1);
      } else if (imgRef.current) {
        const img = imgRef.current;
        img.style.transition = 'transform 200ms ease-out, opacity 200ms ease-out';
        img.style.transform = '';
        img.style.opacity = '';
      }
      overlayClickGuard = Date.now() + 600; // even a spring-back is followed by a click
    }
    d.swiping = false;
    d.dx = 0;
  };
  const onOverlayClick = () => {
    // Swallow exactly the click that follows a completed gesture. After the
    // window passes, a plain tap on the backdrop closes as usual.
    if (Date.now() < overlayClickGuard) { overlayClickGuard = 0; return; }
    photoClose();
  };
  const stopDrag = (e) => { if (e) e.stopPropagation(); };


  const openLightbox = useCallback((e) => {
    if (e) e.preventDefault();
    if (url && idRef.current) photoOpen(idRef.current);
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

      {isActive && url && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onClick={onOverlayClick}
          onPointerDown={swipeDown}
          onPointerMove={swipeMove}
          onPointerUp={swipeUp}
          onPointerCancel={swipeUp}
          style={{ touchAction: 'pan-y' }}
        >
          {total > 1 && (
            <button
              type="button"
              aria-label="Previous photo"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); photoStep(-1); }}
              className="absolute left-2 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-ink/60 text-[24px] leading-none text-paper hover:bg-ink/85"
            >
              ‹
            </button>
          )}
          <img
            ref={imgRef}
            src={url}
            alt={alt}
            className="max-h-[92vh] max-w-full select-none rounded-lg object-contain shadow-raise"
            draggable={false}
            onDragStart={stopDrag}
            onClick={(e) => e.stopPropagation()}
          />
          {total > 1 && (
            <button
              type="button"
              aria-label="Next photo"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); photoStep(1); }}
              className="absolute right-2 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-ink/60 text-[24px] leading-none text-paper hover:bg-ink/85"
            >
              ›
            </button>
          )}
          <button
            type="button"
            aria-label="Close"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={photoClose}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-ink/60 text-[18px] text-paper hover:bg-ink/80"
          >
            ✕
          </button>
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex flex-col items-center gap-0.5 bg-gradient-to-t from-ink/70 to-transparent px-4 pb-3 pt-12">
            {name && <p className="max-w-full truncate text-[12px] text-paper/85">{name}</p>}
            {total > 1 && <p className="num text-[12px] text-paper/60">{index + 1} of {total}</p>}
          </div>
        </div>
      )}
    </>
  );
}
