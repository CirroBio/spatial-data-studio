import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Viv (@vivjs/*) pulls its own copies of deck.gl/luma/math.gl peers; a duplicate
// instance breaks deck.gl layer registration and instanceof checks, so force a single
// copy of each shared package. Pre-bundle the Viv subpackages so their ESM resolves
// cleanly in dev.
const DEDUPE = [
  '@deck.gl/core',
  '@luma.gl/core',
  '@luma.gl/engine',
  '@luma.gl/webgl',
  '@math.gl/core',
];

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: DEDUPE },
  optimizeDeps: {
    include: ['@vivjs/loaders', '@vivjs/layers'],
  },
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
    },
  },
});
