import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import ViewerEmbed from './components/ViewerEmbed.vue';

// Registered globally so any page under docs-site/ can drop in <ViewerEmbed />.
// Published repo markdown must not use it — see the docs-site rule in CLAUDE.md.
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ViewerEmbed', ViewerEmbed);
  },
} satisfies Theme;
