import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The shared development registration on dev.cirro.bio lists http://localhost:5171 as
// this app's redirect URI. Sign-in only returns to the exact address registered, so the
// port is fixed rather than picked from whatever is free.
const DEV_PORT = 5171;

// Same single-copy rule as the Studio frontend: Viv pulls its own deck.gl/luma/math.gl
// peers, and a second instance breaks layer registration and instanceof checks.
const DEDUPE = ['@deck.gl/core', '@luma.gl/core', '@luma.gl/engine', '@luma.gl/webgl', '@math.gl/core'];

// The examples are this app's own (cirro-studio/examples, with its index) plus the docs
// site's demo checkpoints, which the index names at their published place beside the
// app (`../../viewer/`). The Pages build lays the site out that way; in development both
// folders are served from where they live.
const MOUNTS: Record<string, string> = {
  '/examples/': resolve(__dirname, 'examples'),
  '/viewer/': resolve(__dirname, '../docs-site/viewer-data'),
};

function serveFiles(server: { middlewares: Connect.Server }) {
  for (const [mount, dir] of Object.entries(MOUNTS)) {
    server.middlewares.use(mount, (req, res, next) => {
      const name = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''));
      const file = resolve(dir, name);
      if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) return next();
      const size = statSync(file).size;
      // The zip reader asks for byte ranges, the way it reads them from Pages or S3.
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      res.setHeader('Accept-Ranges', 'bytes');
      if (!range) {
        res.setHeader('Content-Length', size);
        createReadStream(file).pipe(res);
        return;
      }
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      createReadStream(file, { start, end }).pipe(res);
    });
  }
}

// The same files for `vite` and for `vite preview` of a build.
const serveExamples = (): Plugin => ({ name: 'serve-examples', configureServer: serveFiles, configurePreviewServer: serveFiles });

export default defineConfig({
  // Relative asset URLs: the app is served under a path on GitHub Pages.
  base: './',
  plugins: [react(), serveExamples()],
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
  server: { port: DEV_PORT, strictPort: true, host: 'localhost' },
  preview: { port: DEV_PORT, strictPort: true, host: 'localhost' },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    // See frontend/vitest.config.ts: the viewer entry re-exports the canvases, and
    // @geoarrow/deck.gl-layers' extensionless imports only resolve through Vite.
    server: { deps: { inline: [/@geoarrow\/deck\.gl-layers/] } },
  },
});
