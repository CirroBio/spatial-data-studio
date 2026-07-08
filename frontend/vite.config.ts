import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
      // Snapshot HTML files are served by the backend's StaticFiles mount, not Vite.
      '/snapshots': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
});
