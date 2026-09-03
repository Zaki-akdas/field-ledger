/**
 * Offline outbox flush — async for PostgreSQL.
 */
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { SYNC_TYPES, HttpError } from '../mutations.js';

export const router = Router();
router.use(requireAuth);

router.post('/', async (req, res, next) => {
  try {
    const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
    if (ops.length === 0) return res.json({ results: [] });

    const results = [];
    for (const op of ops) {
      const fn = SYNC_TYPES[op?.type];
      if (!fn) {
        results.push({ id: op?.id, ok: false, error: `Unknown entry type "${op?.type}".` });
        continue;
      }
      try {
        const out = await fn({ payload: { ...(op.payload || {}), client_id: op.id }, user: req.user });
        results.push({ id: op.id, ok: true, deduped: Boolean(out.deduped), data: out });
      } catch (err) {
        results.push({
          id: op.id,
          ok: false,
          error: err.message,
          status: err instanceof HttpError ? err.status : 500,
        });
      }
    }
    res.json({ results });
  } catch (err) { next(err); }
});
