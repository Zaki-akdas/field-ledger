/**
 * Vercel serverless entry point.
 *
 * The full Express app (API + health + realtime endpoint) is exported as the
 * request handler. vercel.json rewrites every /api/* request to this function
 * while Vercel's static hosting serves the built SPA (client/dist) directly,
 * so the app's own static-serving code is only used on long-running hosts.
 *
 * Do not `app.listen()` here — on Vercel the platform invokes the exported
 * handler per request. server/index.js is the entry point for Node hosts.
 */
export { default } from '../server/app.js';
