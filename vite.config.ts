import { defineConfig } from 'vite';

// Dev: cùng origin với server Game2 để cookie phiên và WS hoạt động như production.
const SERVER_HTTP_TARGET = 'http://127.0.0.1:8787';
const SERVER_WS_TARGET = 'ws://127.0.0.1:8787';

export default defineConfig({
  server: {
    // Cố định IPv4: hub redirect về http://127.0.0.1:5173, không phải [::1].
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/auth': { target: SERVER_HTTP_TARGET },
      '/health': { target: SERVER_HTTP_TARGET },
      '/ws': { target: SERVER_WS_TARGET, ws: true },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
