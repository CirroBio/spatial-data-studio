import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Reuses the app's vite config so `@cirrobio/spatial-viewer` resolves to the workspace
// sources here exactly as it does in a build. happy-dom rather than jsdom: all the
// encoder needs is `window.location`/`history`, and jsdom's CSS stack pulls an ESM-only
// dependency its CJS entry can't require under the vitest pool.
export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    // The encoder imports the viewer package's defaults, and the package's single entry
    // re-exports the canvases with it. Vite tree-shakes that away in a build (the canvas
    // chunk stays split), but vitest externalizes node_modules by default and
    // @geoarrow/deck.gl-layers' extensionless internal imports don't resolve under
    // node's ESM rules. Inlining it routes those through Vite's resolver instead.
    server: { deps: { inline: [/@geoarrow\/deck\.gl-layers/] } },
  },
}));
