import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Vite 5 polyfills: stellar-sdk uses Node.js Buffer / process in the browser.
  // We define stubs here so the browser build resolves them without a full
  // polyfill plugin.
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      // Some stellar-sdk transitive deps import 'stream', 'buffer', etc.
      // browser-compatible stubs come from the vite built-in handling when
      // skipLibCheck is on, but we alias the most common one explicitly.
      buffer: 'buffer',
    },
  },
  optimizeDeps: {
    // Force Vite to pre-bundle these CJS packages so ESM interop works.
    include: ['buffer'],
  },
});
