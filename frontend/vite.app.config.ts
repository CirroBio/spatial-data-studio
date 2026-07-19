import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import viewerMeta from '../snapshot-viewer.json';

// Single source of truth (SNAPSHOT_CONTRACT §1): the published viewer version and
// the schema major this bundle understands both derive from snapshot-viewer.json.
const version = viewerMeta.version;
const schemaMajor = version.split('.')[0];

// Fold the single emitted CSS asset into the IIFE and inject it as a <style> tag
// at runtime, so the published viewer is ONE self-contained app.js with no <link>
// (SNAPSHOT_CONTRACT §7). Also drop a `.nojekyll` at the dist-app site root so
// GitHub Pages serves the versioned path verbatim.
function inlineCssAndSiteFiles(): Plugin {
  return {
    name: 'inline-css-and-site-files',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      let css = '';
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'asset' && fileName.endsWith('.css')) {
          css += typeof chunk.source === 'string' ? chunk.source : Buffer.from(chunk.source).toString('utf8');
          delete bundle[fileName];
        }
      }
      if (css) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type === 'chunk' && chunk.isEntry) {
            const injector =
              '(function(){var s=document.createElement("style");' +
              's.textContent=' + JSON.stringify(css) + ';document.head.appendChild(s);})();\n';
            chunk.code = injector + chunk.code;
          }
        }
      }
      this.emitFile({ type: 'asset', fileName: '.nojekyll', source: '' });
    },
  };
}

export default defineConfig({
  plugins: [react(), inlineCssAndSiteFiles()],
  // Keep a single copy of the deck.gl/luma/math.gl stack in the snapshot-viewer
  // bundle too (mirrors vite.config.ts). The viewer imports no Viv, so no
  // optimizeDeps entry is needed here.
  resolve: {
    dedupe: ['@deck.gl/core', '@luma.gl/core', '@luma.gl/engine', '@luma.gl/webgl', '@math.gl/core'],
  },
  base: './',
  define: {
    __VIEWER_SCHEMA_MAJOR__: JSON.stringify(schemaMajor),
  },
  build: {
    outDir: 'dist-app',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,  // inline every asset; the bundle must be a single file
    rollupOptions: {
      input: 'src/app-entry.tsx',
      output: {
        format: 'iife',
        name: 'SpatialDataStudioViewer',
        inlineDynamicImports: true,
        entryFileNames: `viewer/${version}/app.js`,
      },
    },
  },
});
