import DefaultTheme from 'vitepress/theme';
import './style.css';
import type { Theme } from 'vitepress';
import Layout from './components/Layout.vue';
import LandingPage from './components/LandingPage.vue';
import ViewerEmbed from './components/ViewerEmbed.vue';

// Layout wraps the stock one to add the Cirro brand rule and the header lockup —
// see components/Layout.vue.
//
// LandingPage and ViewerEmbed are registered globally so any page under docs-site/ can
// drop in <ViewerEmbed />, and so docs-site/index.md — the site's landing page — is one
// line. Published repo markdown must not use it — see the docs-site rule in CLAUDE.md.
export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('LandingPage', LandingPage);
    app.component('ViewerEmbed', ViewerEmbed);
  },
} satisfies Theme;
