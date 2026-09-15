import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './index.css';

import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { reportError } from './lib/errorReport.js';

// Global nets: anything outside React's tree (event handlers, async promises,
// uncaught exceptions) still reaches the sink. The ErrorBoundary only sees
// render-phase crashes — these two cover the rest.
window.addEventListener('error', (event) => {
  if (event?.error) reportError(event.error, { kind: 'window_error' });
});
window.addEventListener('unhandledrejection', (event) => {
  if (event?.reason) reportError(event.reason, { kind: 'unhandled_rejection' });
});

// Service worker: offline app shell + stale-while-revalidate field reads.
// Registered only in production builds — Vite dev never has a stable asset
// graph to cache, and a stale dev worker is misery.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // New worker waiting means a new build shipped: surface it once it
      // takes control (activate broadcasts 'sw:updated').
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            nw.postMessage({ type: 'skip-waiting' });
          }
        });
      });
    }).catch(() => { /* offline PWA is best-effort */ });
  });
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'sw:updated') {
      window.dispatchEvent(new CustomEvent('field-ledger:sw-updated', { detail: event.data }));
    }
  });
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
