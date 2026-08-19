import { defineConfig } from 'vitepress';

// The site publishes the repo's own markdown, unmodified, by pointing `srcDir` at the
// repo root: the file tree *is* the route tree, so the relative links the docs already
// use between each other (README -> DEVELOPMENT -> DESIGN -> docs/CONTRACT ->
// backend/README) keep working and are dead-link-checked on every build. Nothing here
// may fork or paraphrase those files — see the docs-site rule in CLAUDE.md. Pages under
// docs-site/ are the only new prose, and the only place <ViewerEmbed> may appear.
export default defineConfig({
  srcDir: '..',
  base: '/spatial-data-studio/',
  title: 'Spatial Data Studio',
  description: 'Interactive analysis and visualization for spatial transcriptomics.',
  cleanUrls: true,
  lastUpdated: true,

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
    'README.md': 'index.md',
    'docs-site/demo/index.md': 'demo/index.md',
    'docs-site/demo/xenium-pancreas.md': 'demo/xenium-pancreas.md',
    'docs-site/demo/visium-colon.md': 'demo/visium-colon.md',
    'docs-site/demo/visium-mouse-brain.md': 'demo/visium-mouse-brain.md',
  },

  themeConfig: {
    outline: [2, 3],
    nav: [
      { text: 'Use', link: '/' },
      { text: 'Demos', link: '/demo/' },
      { text: 'Develop', link: '/DEVELOPMENT' },
      { text: 'Reference', link: '/DESIGN' },
    ],
    // Mirrors the audience split CLAUDE.md draws: README is the user-facing source of
    // truth, DEVELOPMENT the developer-facing one, and the rest is reference.
    sidebar: [
      {
        text: 'Use',
        items: [
          { text: 'Overview', link: '/' },
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
