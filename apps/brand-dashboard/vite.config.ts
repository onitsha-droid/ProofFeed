import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
  },
  preview: {
    port: 5174,
  },
  // Brand dashboard is read-only — no wallet SDK, no stellar-sdk browser polyfills needed.
  // We still define global for any transitive dep that expects it.
  define: {
    global: 'globalThis',
  },
});
