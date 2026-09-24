<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import SiteBrand from './SiteBrand.vue';

const { Layout } = DefaultTheme;

// Two additions to the stock layout: the Cirro gradient rule above the navigation bar,
// and the Cirro-plus-product lockup in place of VitePress's plain site title. Shared
// between prompt-nb's docs-site and Spatial Data Studio's — see the note at the top of
// theme/style.css.
</script>

<template>
  <Layout>
    <template #layout-top>
      <div class="topline"></div>
    </template>
    <template #nav-bar-title-before>
      <SiteBrand />
    </template>
  </Layout>
</template>

<style scoped>
/* Cirro's brand gradient, deep navy through to the logo's cyan. It sits above the
   navigation bar in the document, which VitePress fixes to the top, so the rule has to
   be fixed with it rather than scrolling away. */
.topline {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  z-index: 100;
  background: linear-gradient(90deg,
    #070b24, #1a324a, #23465e, #2d5a71, #408197, #4995ab, #53a8be, #5cbcd1);
}
</style>
