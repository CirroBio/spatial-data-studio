<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';

// A live serverless viewer on a docs page, as an iframe over the real built SPA.
//
// Not the `@cirrobio/spatial-viewer` library, deliberately: this site is Vue and the
// library is React, the library ships no control panel (controls stay app-side behind a
// render-prop slot, so a page built on it would have nothing to click), and it needs a
// CanvasHost adapter written per host. The iframe gets the whole app for free, keeps its
// WebGL context disposable, and — because the SPA and the .zarr.zip files are served
// from this same origin — needs no CORS for the reader's HTTP range requests.
//
// Nothing loads until the reader asks: the SPA bundle is ~4 MB, so three demos on one
// page would otherwise cost 12 MB up front.
const props = withDefaults(defineProps<{
  /** Path relative to `viewer/index.html`, or an absolute URL. */
  checkpoint?: string;
  label?: string;
  description?: string;
  height?: string;
  poster?: string;
  /** Load on scroll-into-view instead of on click. */
  eager?: boolean;
  /** 'minimal' adds `embed=1`: no header, sidebar, picker or in-canvas controls. */
  chrome?: 'full' | 'minimal';
  /** 'index' omits `?checkpoint=` so the frame shows the collection landing page. */
  mode?: 'checkpoint' | 'index';
  /** The viewer's own UI theme. Light by default, to sit inside the page rather than
   * punch a dark hole in it; the reader can still switch it inside the frame. */
  theme?: 'light' | 'dark';
  /** The spatial canvas' background behind the image. */
  background?: 'light' | 'dark';
}>(), {
  height: '640px',
  chrome: 'full',
  mode: 'checkpoint',
  eager: false,
  theme: 'light',
  background: 'light',
});

const active = ref(false);
const host = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

const src = computed(() => {
  const params = new URLSearchParams();
  if (props.mode === 'checkpoint' && props.checkpoint) params.set('checkpoint', props.checkpoint);
  if (props.chrome === 'minimal') params.set('embed', '1');
  params.set('theme', props.theme);
  params.set('background', props.background);
  const query = params.toString();
  return withBase('/viewer/index.html') + (query ? `?${query}` : '');
});

const title = computed(() => props.label ?? props.checkpoint?.split('/').pop() ?? 'Spatial Data Studio');

function activate() {
  active.value = true;
}

// Dropping the iframe is the only way to be sure the WebGL context goes with it; an
// unmounted canvas can sit on one until the browser decides to reclaim it.
function unload() {
  active.value = false;
}

onMounted(() => {
  if (!props.eager || !host.value || typeof IntersectionObserver === 'undefined') return;
  observer = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    activate();
    observer?.disconnect();
    observer = null;
  }, { rootMargin: '200px' });
  observer.observe(host.value);
});

onBeforeUnmount(() => { observer?.disconnect(); observer = null; });
</script>

<template>
  <figure ref="host" class="viewer-embed">
    <figcaption class="viewer-embed__bar">
      <span class="viewer-embed__title">{{ title }}</span>
      <span class="viewer-embed__actions">
        <a :href="src" target="_blank" rel="noopener">Open in a new tab</a>
        <button v-if="active" type="button" @click="unload">Unload</button>
      </span>
    </figcaption>

    <div class="viewer-embed__frame" :style="{ height }">
      <iframe
        v-if="active"
        :src="src"
        :title="title"
        loading="lazy"
        allow="fullscreen"
        referrerpolicy="no-referrer"
      />
      <button v-else type="button" class="viewer-embed__poster" @click="activate">
        <img v-if="poster" :src="withBase(poster)" alt="" />
        <span class="viewer-embed__cta">Load interactive viewer</span>
        <span class="viewer-embed__hint">Runs the real viewer in your browser — no server involved.</span>
      </button>
    </div>

    <p v-if="description" class="viewer-embed__desc">{{ description }}</p>
  </figure>
</template>

<style scoped>
.viewer-embed {
  margin: 24px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: hidden;
}
.viewer-embed__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  background: var(--vp-c-bg-soft);
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 13px;
}
.viewer-embed__title { font-weight: 600; }
.viewer-embed__actions { display: flex; gap: 12px; align-items: center; }
.viewer-embed__actions button {
  font-size: 13px;
  color: var(--vp-c-text-2);
  cursor: pointer;
}
.viewer-embed__actions button:hover { color: var(--vp-c-text-1); }
.viewer-embed__frame { position: relative; width: 100%; background: var(--vp-c-bg-alt); }
.viewer-embed__frame iframe { width: 100%; height: 100%; border: 0; display: block; }
.viewer-embed__poster {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  position: relative;
}
.viewer-embed__poster img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0.35;
}
.viewer-embed__cta {
  position: relative;
  padding: 8px 16px;
  border-radius: 6px;
  background: var(--vp-c-brand-1);
  color: var(--vp-c-white);
  font-size: 14px;
  font-weight: 500;
}
.viewer-embed__hint { position: relative; font-size: 12px; color: var(--vp-c-text-2); }
.viewer-embed__desc {
  margin: 0;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--vp-c-text-2);
  border-top: 1px solid var(--vp-c-divider);
}
</style>
