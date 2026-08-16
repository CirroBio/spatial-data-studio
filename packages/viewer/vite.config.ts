import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Every rendering dependency is external. deck.gl registers layers on a module-level
// registry and checks `instanceof` across package boundaries, so a bundled second copy
// of @deck.gl/core, @luma.gl/* or @math.gl/core silently breaks picking and layer
// updates — the same reason the app's vite config dedupes them. Peer versions declared
// in package.json; consumers must dedupe (see README).
const EXTERNAL = [
  /^react($|\/)/,
  /^react-dom($|\/)/,
  /^@deck\.gl\//,
  /^@luma\.gl\//,
  /^@math\.gl\//,
  /^@vivjs\//,
  /^@geoarrow\//,
  /^@zarrita\//,
  /^zarrita($|\/)/,
  /^apache-arrow($|\/)/,
  /^zod($|\/)/,
];

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es', 'cjs'],
      // ESM gets .mjs so the CJS default (no "type": "module"; see README) still
      // applies to dist/index.js.
      fileName: (format) => (format === 'es' ? 'index.mjs' : 'index.js'),
    },
    rollupOptions: { external: EXTERNAL },
    sourcemap: true,
  },
});
