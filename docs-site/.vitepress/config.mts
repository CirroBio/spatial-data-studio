import { defineConfig } from 'vitepress';

// The site publishes the repo's own markdown, unmodified, by pointing `srcDir` at the
// repo root: the file tree *is* the route tree, so the relative links the docs already
// use between each other (README -> USER_GUIDE -> DEVELOPMENT -> DESIGN -> docs/CONTRACT ->
// backend/README) keep working and are dead-link-checked on every build. Nothing here
// may fork or paraphrase those files — see the docs-site rule in CLAUDE.md. Pages under
// docs-site/ are the only new prose, and the only place <ViewerEmbed> may appear. The
// landing page (docs-site/index.md -> LandingPage.vue) is the one exception that rule
// names: it presents and routes, and must not become the only place a fact is written.

// The Cirro brand mark, the same geometry as frontend/public/favicon.svg: a ring with a
// blank channel carved through it by the two-node link glyph. It is the site's favicon.
// Inlined as a data URI because VitePress only ever serves a public directory at
// `<srcDir>/public` — here the repo root — and a top-level public/ folder existing solely
// to hold this one file would be worse than the encoding. Both fills are brand colors, so
// one mark serves both themes.
const CIRRO_MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-103.9 -134.2 262 262">
  <mask id="c" maskUnits="userSpaceOnUse" x="-176" y="-176" width="352" height="352">
    <rect x="-176" y="-176" width="352" height="352" fill="#fff"/>
    <path d="M 17.66 -36.53 A 38.71 38.71 0 0 0 73.12 -68.69 A 40.57 40.57 0 1 1 95.94 -29.34 A 38.71 38.71 0 0 0 40.47 2.82 A 40.57 40.57 0 1 1 17.66 -36.53 Z" fill="#000" stroke="#000" stroke-width="34.8"/>
  </mask>
  <circle r="79" fill="none" stroke="#0e7ca0" stroke-width="42" mask="url(#c)"/>
  <path d="M 17.66 -36.53 A 38.71 38.71 0 0 0 73.12 -68.69 A 40.57 40.57 0 1 1 95.94 -29.34 A 38.71 38.71 0 0 0 40.47 2.82 A 40.57 40.57 0 1 1 17.66 -36.53 Z" fill="#24bfd3"/>
</svg>`;

export default defineConfig({
  srcDir: '..',
  base: '/spatial-data-studio/',
  title: 'Spatial Data Studio',
  description: 'Interactive analysis and visualization for spatial transcriptomics.',
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ['link', { rel: 'icon', href: `data:image/svg+xml,${encodeURIComponent(CIRRO_MARK)}` }],
  ],

  // With the whole repo as srcDir, anything not excluded becomes a page. Agent
  // instructions, governance skills and the MCP guides are written for tools, not
  // readers; the rest is build output or bulk data that happens to contain markdown.
  srcExclude: [
    '**/node_modules/**',
    'packages/*/dist/**',
    'frontend/dist/**',
    '.claude/**',
    'data/**',
    'test-data/**',
    'nextflow/work/**',
    'CLAUDE.md',
    'AGENTS.md',
    'sds-governance/AGENTS.md',
    'sds-governance/skills/**',
    'backend/app/mcp/guides/**',
  ],

  // The dead-link check is the guard that keeps published markdown honest, so these are
  // the only exemptions: `/viewer/` is the built SPA the deploy job copies in beside the
  // site (a real path, just not a VitePress page), and the agent-instruction files are
  // real repo files that srcExclude deliberately keeps off a reader-facing site.
  ignoreDeadLinks: [
    /^\/viewer\//,
    /(^|\/)CLAUDE$/,
    /(^|\/)AGENTS$/,
  ],

  rewrites: {
    // `/` is the site's own landing page (the only presentation-first page here); the
    // README keeps its orientation job at `/overview`, and the links other docs make to
    // `../README.md` resolve through this map.
    'docs-site/index.md': 'index.md',
    'README.md': 'overview.md',
    'docs-site/demo/index.md': 'demo/index.md',
    'docs-site/demo/xenium-pancreas.md': 'demo/xenium-pancreas.md',
    'docs-site/demo/visium-colon.md': 'demo/visium-colon.md',
    'docs-site/demo/visium-mouse-brain.md': 'demo/visium-mouse-brain.md',
  },

  themeConfig: {
    // The header lockup is theme/components/SiteBrand.vue, filled into the nav bar's
    // title slot by theme/components/Layout.vue — the same Cirro-wordmark-plus-product
    // header prompt-nb's docs carry. VitePress's own title would sit beside it saying
    // the name a second time.
    siteTitle: false,
    outline: [2, 3],
    nav: [
      { text: 'Use', link: '/overview' },
      { text: 'Guide', link: '/docs/USER_GUIDE' },
      { text: 'Demos', link: '/demo/' },
      { text: 'Develop', link: '/DEVELOPMENT' },
      { text: 'Reference', link: '/DESIGN' },
    ],
    // Mirrors the audience split CLAUDE.md draws: README orients and routes,
    // docs/USER_GUIDE is the user-facing source of truth, DEVELOPMENT the
    // developer-facing one, and the rest is reference.
    sidebar: [
      {
        text: 'Use',
        items: [
          { text: 'Overview', link: '/overview' },
          { text: 'User guide', link: '/docs/USER_GUIDE' },
          {
            text: 'Live demos',
            link: '/demo/',
            items: [
              { text: 'Xenium human pancreas', link: '/demo/xenium-pancreas' },
              { text: 'Visium human colon', link: '/demo/visium-colon' },
              { text: 'Visium mouse brain', link: '/demo/visium-mouse-brain' },
            ],
          },
          { text: 'Run with Docker', link: '/docker/README' },
          { text: 'Analysis methods', link: '/backend/app/registry/custom/README' },
        ],
      },
      {
        text: 'Develop',
        items: [
          { text: 'Development guide', link: '/DEVELOPMENT' },
          { text: 'Contributing analyses', link: '/CONTRIBUTING' },
          { text: 'Backend', link: '/backend/README' },
          { text: 'Frontend', link: '/frontend/README' },
          { text: 'Viewer library', link: '/packages/viewer/README' },
          { text: 'Nextflow', link: '/nextflow/README' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Design', link: '/DESIGN' },
          { text: 'API contract', link: '/docs/CONTRACT' },
          { text: 'Checkpoint format', link: '/docs/CHECKPOINT_FORMAT' },
          { text: 'Embed protocol', link: '/docs/EMBED_PROTOCOL' },
          { text: 'Governance rules', link: '/sds-governance/RULES' },
          { text: 'License', link: '/LICENSE' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/CirroBio/spatial-data-studio' },
    ],
    search: { provider: 'local' },
  },
});
