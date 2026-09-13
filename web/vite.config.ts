import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The board server only accepts same-origin JSON writes. In development the page comes from Vite (5173)
// while the API lives on the board server, so the proxy presents requests as coming from the board origin.
const BOARD = process.env.QUESTBOARD_URL || 'http://127.0.0.1:6097';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: BOARD,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => {
            if (request.getHeader('origin')) request.setHeader('origin', BOARD);
            request.removeHeader('sec-fetch-site');
          });
        },
      },
      '/review': { target: BOARD, changeOrigin: true },
    },
  },
});
