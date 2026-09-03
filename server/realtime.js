/**
 * Server-Sent Events endpoint for live data sync.
 * Uses PostgreSQL LISTEN/NOTIFY to detect changes in real-time,
 * then broadcasts them to all connected SSE clients.
 */
import { Router } from 'express';
import pg from 'pg';
import { userForToken } from './auth.js';

export const router = Router();

/** Connected SSE clients. */
const clients = new Set();

/** Broadcast an event to all connected SSE clients. */
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

/** Set up PostgreSQL LISTEN for each table we care about. */
const TABLES = ['collections', 'bills', 'cancellations', 'short_items'];
let reconnectDelay = 1000;

async function setupListeners() {
  const listener = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  try {
    await listener.connect();
    reconnectDelay = 1000; // Reset backoff on success
    console.log('[realtime] PostgreSQL listener connected');

    for (const table of TABLES) {
      const channel = `realtime_${table}`;
      await listener.query(`LISTEN "${channel}"`);
      console.log(`[realtime] Listening on ${channel}`);
    }

    listener.on('notification', (msg) => {
      const channel = msg.channel;
      const table = channel.replace('realtime_', '');
      let payload;
      try {
        payload = JSON.parse(msg.payload);
      } catch {
        payload = { operation: 'unknown' };
      }
      broadcast(table, { table, ...payload });
    });

    listener.on('error', (err) => {
      console.error('[realtime] Listener error:', err.message);
      listener.end().catch(() => {});
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      setTimeout(setupListeners, delay);
    });

    listener.on('end', () => {
      console.log('[realtime] Listener disconnected — reconnecting…');
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      setTimeout(setupListeners, delay);
    });
  } catch (err) {
    console.error('[realtime] Failed to connect listener:', err.message);
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    setTimeout(setupListeners, delay);
  }
}

// Start listeners on server boot (delayed to let the server start first).
// Skipped on serverless hosts (Vercel) — every warm function instance would
// otherwise hold its own LISTEN connection open.
if (!process.env.VERCEL) {
  setTimeout(setupListeners, 1000);
}

/** GET /api/realtime — SSE stream. */
router.get('/', async (req, res) => {
  // Auth via query param (EventSource can't send headers)
  const token = req.query.token;
  if (token) {
    req.user = await userForToken(token);
  }
  if (!req.user) return res.status(401).json({ error: 'Sign in to connect to realtime.' });

  // Prevent Helmet from adding security headers that break SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial heartbeat
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[realtime] Client connected (${clients.size} total)`);

  // Heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clients.delete(res);
    clearInterval(heartbeat);
    console.log(`[realtime] Client disconnected (${clients.size} total)`);
  });
});

export { broadcast };
