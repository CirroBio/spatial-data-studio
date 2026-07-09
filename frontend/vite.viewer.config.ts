import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the standalone snapshot viewer bundled into a Cirro upload (see
// backend/app/cirro.py). `base: './'` makes all asset URLs relative so the bundle
// renders from any hosted path; output lands in dist-viewer/ (viewer.html is
// copied in as index.html at the bundle root).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist-viewer',
    emptyOutDir: true,
    rollupOptions: { input: 'viewer.html' },
  },
});
