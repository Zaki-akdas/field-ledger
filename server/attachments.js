/**
 * Offline photos arrive as data URLs and are materialised when the entry
 * finally syncs. The actual write is delegated to the shared storage layer
 * (Supabase Storage when configured, local disk otherwise).
 */
export { saveDataUrl } from './storage.js';
