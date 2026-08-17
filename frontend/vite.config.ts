import { resolve } from 'node:path';
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
  // Relative asset URLs so the built SPA works when hosted under any path
  // prefix (e.g. a Cirro bundle behind a signed-URL subpath), not just "/".
  base: './',
  plugins: [react()],
  resolve: {
    dedupe: DEDUPE,
    alias: {
      // The canvas library is a workspace sibling. Resolve it to its sources rather
      // than its build output so `npm run dev` hot-reloads canvas edits and neither
      // the dev server nor `tsc -b` needs packages/viewer/dist to exist first. The
      // published artifact is still built and typechecked by the root `npm run build`.
      '@cirrobio/spatial-viewer': resolve(__dirname, '../packages/viewer/src/index.ts'),
    },
  },
  optimizeDeps: {
    include: ['@vivjs/loaders', '@vivjs/layers'],
  },
  test: {
    // The canvas library has no runner of its own; `npm test` here covers both
    // workspaces so its unit tests run in CI with everything else.
    include: ['src/**/*.test.ts', '../packages/viewer/src/**/*.test.ts'],
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
