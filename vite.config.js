import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    // Only force TLS HMR when tunneled through HTTPS (e.g. Vercel preview).
    // Locally this breaks hot reload — plain ws on the dev port is correct.
    ...(process.env.VITE_HMR_TLS ? { hmr: { protocol: 'wss', clientPort: 443 } } : {}),
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: false },
      '/uploads': { target: 'http://127.0.0.1:4000', changeOrigin: false },
    },
  },
  build: { outDir: '../client/dist', emptyOutDir: true },
});
