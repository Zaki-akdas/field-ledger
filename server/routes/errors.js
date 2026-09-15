import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { recordError } from '../errors.js';

export const router = Router();

// Crash reports arrive unauthenticated (a crash can happen on the login
// screen), so the endpoint needs its own blunt ceiling: 10 reports per IP
// per 5 minutes is far above any real crash rate and starves scripts.
const ingestLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/',
  ingestLimiter,
  async (req, res) => {
    const body = req.body || {};
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return res.status(400).json({ error: 'Report needs a message.' });
    }

    // Report what we know about the actor, without trusting the payload's
    // claim about who they are — req.user comes from the verified Bearer JWT
    // (attachUser/resolveUser already ran), never from the body.
    const user = req.user;

    recordError({
      source: 'client',
      kind: typeof body.kind === 'string' ? body.kind.slice(0, 60) : 'error',
      message: body.message,
      stack: typeof body.stack === 'string' ? body.stack : null,
      component_stack: typeof body.componentStack === 'string' ? body.componentStack : null,
      url: typeof body.url === 'string' ? body.url : req.get('referer') || null,
      user_agent: req.get('user-agent'),
      user_id: user?.id,
      user_code: user?.code || null,
      context: typeof body.context === 'object' && body.context !== null ? body.context : null,
    });

    res.status(204).end();
  },
);
