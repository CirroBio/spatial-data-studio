<script setup lang="ts">
import { withBase } from 'vitepress';
import cirroLight from '../assets/cirro-light.png';
import cirroDark from '../assets/cirro-dark.png';

// The navigation bar's title, in place of VitePress's own (config.mts sets
// `siteTitle: false`): the Cirro lockup, a rule, and the product's name. Shared between
// prompt-nb's docs-site and Spatial Data Studio's, the product name apart — see the note
// at the top of theme/style.css.
//
// Two lockups rather than one recolourable mark: the wordmark is artwork, and the navy
// one on the site's dark navy ground would be invisible.
</script>

<template>
  <a class="brand" :href="withBase('/')" aria-label="Spatial Data Studio">
    <img class="cirro light" :src="cirroLight" width="719" height="202" alt="Cirro" />
    <img class="cirro dark" :src="cirroDark" width="719" height="202" alt="Cirro" />
    <span class="rule" aria-hidden="true"></span>
    <span class="name">spatial data studio</span>
  </a>
</template>

<style scoped>
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  text-decoration: none;
}

.cirro {
  display: block;
  height: 22px;
  width: auto;
}

.cirro.dark { display: none; }
.dark .cirro.light { display: none; }
.dark .cirro.dark { display: block; }

.rule {
  width: 1px;
  height: 20px;
  background: var(--vp-c-divider);
}

.name {
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  letter-spacing: .08em;
  color: var(--vp-c-text-2);
  white-space: nowrap;
  transition: color .25s;
}

.brand:hover .name { color: var(--vp-c-text-1); }

/* Below VitePress's own nav breakpoint the bar is tight enough that the product name is
   what gives way; the lockup alone still says whose site this is. */
@media (max-width: 500px) {
  .rule, .name { display: none; }
}
</style>
