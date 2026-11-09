import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The shared development registration on dev.cirro.bio lists http://localhost:5171 as
// this app's redirect URI. Sign-in only returns to the exact address registered, so the
// port is fixed rather than picked from whatever is free.
const DEV_PORT = 5171;

// The docs are the deployed site's About section (/about/, docs.yml), built from docs-site/
// under a base of their own. In development the app's links to them reach the docs dev
// server (`npm --prefix docs-site run docs:dev -- --port 5180`) through this one: /about/ is rewritten to
// that base, and the pages' own assets and live reload use the base itself.
const DOCS_DEV = 'http://localhost:5180';
const DOCS_BASE = '/spatial-data-studio/about';

// Same single-copy rule as the Studio frontend: Viv pulls its own deck.gl/luma/math.gl
// peers, and a second instance breaks layer registration and instanceof checks.
const DEDUPE = ['@deck.gl/core', '@luma.gl/core', '@luma.gl/engine', '@luma.gl/webgl', '@math.gl/core'];

export default defineConfig({
  // Relative asset URLs: the app is served under a path on GitHub Pages.
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0') },
  resolve: {
    dedupe: DEDUPE,
    alias: {
      // The canvas library is a workspace sibling, resolved to its sources as the Studio
      // frontend does, so neither dev nor typecheck needs packages/viewer/dist.
      '@cirrobio/spatial-viewer': resolve(__dirname, '../packages/viewer/src/index.ts'),
      // The Studio's own display settings, so the two apps show the same panel.
      '@cirrobio/studio-ui': resolve(__dirname, '../packages/studio-ui/src/index.ts'),
    },
  },
  optimizeDeps: { include: ['@vivjs/loaders', '@vivjs/layers'] },
  worker: { format: 'es' },
  server: {
    port: DEV_PORT,
    strictPort: true,
    host: 'localhost',
    proxy: {
      '^/about/': { target: DOCS_DEV, rewrite: (path) => path.replace(/^\/about/, DOCS_BASE) },
      [DOCS_BASE]: { target: DOCS_DEV, ws: true },
    },
  },
  preview: { port: DEV_PORT, strictPort: true, host: 'localhost' },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    // See frontend/vitest.config.ts: the viewer entry re-exports the canvases, and
    // @geoarrow/deck.gl-layers' extensionless imports only resolve through Vite.
    server: { deps: { inline: [/@geoarrow\/deck\.gl-layers/] } },
  },
});
