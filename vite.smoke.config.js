/**
 * IIFE build used only by the jsdom smoke test — jsdom cannot execute
 * <script type="module">, so the test needs a classic script bundle.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../client/dist-smoke',
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: { format: 'iife', entryFileNames: 'app.js', assetFileNames: 'app.[ext]' },
    },
  },
});
