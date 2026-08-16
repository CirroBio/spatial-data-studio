// Shareable view links for the serverless viewer.
//
// The URL carries what the user changed *in this session*, diffed against the display
// encodings as they came out of the `.zarr.zip`. That baseline is what makes the link
// reproducible: a collaborator opens the same `?checkpoint=`, reads the identical
// `app_state` from the identical file, and baseline + delta lands them on the same
// picture. Diffing against static constants could not do this — `color_by`,
// `image_layer` and `show_image` all default off the data, so they would have to be
// shipped in full every time.
//
// If the checkpoint is later re-saved with different encodings, an old link applies its
// delta onto the new baseline: what the user changed still lands, what they didn't
// follows the new file. That is the intended degradation, not a bug to defend against —
// pinning a content hash would turn a soft drift into a hard failure.
//
// This module must not import the store: the store reads it at initialization
// (`initialUiOverlay`) and importing back would be a cycle. Same constraint, and same
// reason, as data/checkpointIndex.ts.
import { z } from 'zod';
import {
  EMBEDDING_ENCODING_DEFAULTS,
  SPATIAL_ENCODING_DEFAULTS,
  isEmbeddingDisplay,
  isSpatialDisplay,
  showImageDefault,
  type DisplayEncoding,
  type EmbeddingDisplaySpec,
  type EmbeddingEncoding,
  type SpatialDisplaySpec,
  type Viewport,
} from '@cirrobio/spatial-viewer';
import type { AppState } from '../types';
import { VIEW_PARAM, checkpointUrlFromLocation, isEmbedMode } from '../data/checkpointIndex';

const VIEW_SCHEMA_VERSION = 1;

// Beyond this a link starts getting mangled by mail and chat clients. The payload is a
// delta, so reaching it takes an unusual amount of per-category recolouring; warn rather
// than silently dropping fields the user actually set.
const LONG_URL_WARN_CHARS = 1800;

/** `mainView` and `leftMenuOpen` as a serverless viewer starts before any URL is read. */
const UI_BASELINE = { mainView: 'canvas' as const, leftMenuOpen: false };

const viewportSchema = z.object({
  t: z.array(z.number()),
  z: z.number(),
  rx: z.number().optional(),
  ro: z.number().optional(),
});

const channelSchema = z.object({
  visible: z.boolean(),
  name: z.string(),
  color: z.string().optional(),
  contrast_limits: z.tuple([z.number(), z.number()]).optional(),
});

const spatialEncodingSchema = z.object({
  coords: z.string(),
  color_by: z.string().nullable(),
  image_layer: z.string().nullable(),
  shapes_layer: z.string().nullable(),
  point_size: z.number(),
  opacity: z.number(),
  colormap: z.string(),
  channels: z.record(channelSchema),
  legend_visible: z.boolean(),
  legend_title: z.string(),
  show_points: z.boolean(),
  show_image: z.boolean(),
  show_channel_legend: z.boolean(),
  show_minimap: z.boolean(),
  isolated_category: z.string().nullable(),
  category_colors: z.record(z.record(z.string())),
  render_mode: z.enum(['points', 'points+shapes', 'shapes']),
  boundary_style: z.enum(['filled', 'outline']),
  boundary_line_width: z.number(),
  point_marker: z.enum(['circle', 'square', 'hexagon']),
  invert_x: z.boolean(),
  invert_y: z.boolean(),
  background: z.enum(['light', 'dark']),
}).partial();

const embeddingEncodingSchema = z.object({
  obsm_key: z.string(),
  x_component: z.number(),
  y_component: z.number(),
  z_component: z.number(),
  is_3d: z.boolean(),
  color_by: z.string().nullable(),
  point_size: z.number(),
  opacity: z.number(),
  colormap: z.string(),
  legend_visible: z.boolean(),
  legend_title: z.string(),
  category_colors: z.record(z.record(z.string())),
}).partial();

const overlaySchema = z.object({
  v: z.literal(VIEW_SCHEMA_VERSION),
  sp: z.object({ enc: spatialEncodingSchema.optional(), vp: viewportSchema.nullable().optional() }).optional(),
  em: z.object({ enc: embeddingEncodingSchema.optional(), vp: viewportSchema.nullable().optional() }).optional(),
  ui: z.object({
    view: z.enum(['canvas', 'embedding']).optional(),
    menu: z.boolean().optional(),
  }).optional(),
});

export type ViewOverlay = z.infer<typeof overlaySchema>;

export interface ViewBaseline {
  spatial: SpatialDisplaySpec | null;
  embedding: EmbeddingDisplaySpec | null;
}

export interface CurrentView extends ViewBaseline {
  mainView: 'canvas' | 'embedding' | 'tables';
  leftMenuOpen: boolean;
}

// ---- encoding -------------------------------------------------------------------

function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);  // legend titles and category levels are arbitrary Unicode
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** JSON with object keys sorted, so two equal encodings built by different spreads
 * compare equal. `category_colors` and `channels` are the ones that matter. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

function defined<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

/** Fill in the defaults an absent field stands for, so `undefined` and the default
 * value compare equal. Without this, toggling a setting off and back on would emit it.
 * `show_image` defaults off `image_layer`, so it is resolved per side. */
function normalizeSpatial(e: DisplayEncoding): Record<string, unknown> {
  return { ...SPATIAL_ENCODING_DEFAULTS, show_image: showImageDefault(e), ...defined(e) };
}

function normalizeEmbedding(e: EmbeddingEncoding): Record<string, unknown> {
  return { ...EMBEDDING_ENCODING_DEFAULTS, ...defined(e) };
}

/** Keys whose normalized value differs, carrying the *current* value.
 * `channels` and `category_colors` are nested maps, so they replace wholesale — a
 * per-key merge would need tombstones to say "the user removed this override". */
function diffEncoding(
  current: Record<string, unknown>, baseline: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    if (stableJson(current[key]) !== stableJson(baseline[key])) out[key] = current[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function compactViewport(v: Viewport | null): z.infer<typeof viewportSchema> | null {
  if (!v) return null;
  return {
    t: v.target,
    z: v.zoom,
    ...(v.rotationX !== undefined ? { rx: v.rotationX } : {}),
    ...(v.rotationOrbit !== undefined ? { ro: v.rotationOrbit } : {}),
  };
}

function expandViewport(v: z.infer<typeof viewportSchema> | null | undefined): Viewport | null {
  if (!v) return null;
  return {
    target: v.t,
    zoom: v.z,
    ...(v.rx !== undefined ? { rotationX: v.rx } : {}),
    ...(v.ro !== undefined ? { rotationOrbit: v.ro } : {}),
  };
}

// The baseline the URL is written against: the checkpoint's own displays, captured
// before any overlay is applied. Module state rather than a parameter so the writer
// hook does not have to thread it through every store tick.
let baseline: ViewBaseline | null = null;

export function setViewBaseline(next: ViewBaseline): void {
  baseline = next;
}

export function buildOverlay(current: CurrentView): ViewOverlay | null {
  if (!baseline) return null;
  const overlay: ViewOverlay = { v: VIEW_SCHEMA_VERSION };

  if (current.spatial && baseline.spatial) {
    const enc = diffEncoding(
      normalizeSpatial(current.spatial.encoding), normalizeSpatial(baseline.spatial.encoding),
    );
    const vp = compactViewport(current.spatial.viewport);
    const vpChanged = stableJson(vp) !== stableJson(compactViewport(baseline.spatial.viewport));
    if (enc || vpChanged) overlay.sp = { ...(enc ? { enc } : {}), ...(vpChanged ? { vp } : {}) };
  }
  if (current.embedding && baseline.embedding) {
    const enc = diffEncoding(
      normalizeEmbedding(current.embedding.encoding), normalizeEmbedding(baseline.embedding.encoding),
    );
    const vp = compactViewport(current.embedding.viewport);
    const vpChanged = stableJson(vp) !== stableJson(compactViewport(baseline.embedding.viewport));
    if (enc || vpChanged) overlay.em = { ...(enc ? { enc } : {}), ...(vpChanged ? { vp } : {}) };
  }

  // 'tables' is backend-only, so it never reaches a shared link.
  const view = current.mainView === 'tables' ? UI_BASELINE.mainView : current.mainView;
  const ui = {
    ...(view !== UI_BASELINE.mainView ? { view } : {}),
    ...(current.leftMenuOpen !== UI_BASELINE.leftMenuOpen ? { menu: current.leftMenuOpen } : {}),
  };
  if (Object.keys(ui).length) overlay.ui = ui;

  return overlay.sp || overlay.em || overlay.ui ? overlay : null;
}

export function encodeViewOverlay(overlay: ViewOverlay | null): string | null {
  if (!overlay) return null;
  return toBase64Url(stableJson(overlay));
}

/** True when the encoded payload is long enough that a mail or chat client may break
 * it. The caller decides how to say so; nothing is dropped either way. */
export function isOverlayOversized(encoded: string | null): boolean {
  return !!encoded && encoded.length > LONG_URL_WARN_CHARS;
}

/** The current URL with `view` set to `encoded` (or removed when null). Every other
 * parameter — `checkpoint`, `embed` — is preserved. */
export function viewHref(encoded: string | null): string {
  const url = new URL(window.location.href);
  if (encoded) url.searchParams.set(VIEW_PARAM, encoded);
  else url.searchParams.delete(VIEW_PARAM);
  return url.href;
}

// ---- decoding -------------------------------------------------------------------

let decoded: { overlay: ViewOverlay | null; malformed: boolean } | undefined;

/** Decoded once per page load and memoized: the URL is write-only after mount, so
 * nothing re-reads `location.search` and there is no feedback loop to guard against. */
function readUrl(): { overlay: ViewOverlay | null; malformed: boolean } {
  if (decoded) return decoded;
  // Only in the serverless viewer, and never in embed mode: there the dashboard owns
  // display state over postMessage and a URL writer would be a third writer racing
  // `apply-display`. In the backed app the encoding is server-persisted and shared, and
  // sharing is already solved by the session id.
  const raw = checkpointUrlFromLocation() === null || isEmbedMode()
    ? null
    : new URLSearchParams(window.location.search).get(VIEW_PARAM);
  if (!raw) return (decoded = { overlay: null, malformed: false });
  try {
    const parsed = overlaySchema.safeParse(JSON.parse(fromBase64Url(raw)));
    return (decoded = parsed.success
      ? { overlay: parsed.data, malformed: false }
      : { overlay: null, malformed: true });
  } catch {
    return (decoded = { overlay: null, malformed: true });  // bad base64 or bad JSON
  }
}

export function urlViewOverlay(): ViewOverlay | null {
  return readUrl().overlay;
}

/** A `view` parameter was present but unreadable — a stale or truncated link. The
 * checkpoint's own view renders; the caller says so once. */
export function urlViewMalformed(): boolean {
  return readUrl().malformed;
}

/** The UI half of the overlay, safe to call at store-initialization time. `mainView`
 * decides which canvas mounts and `leftMenuOpen` changes the first paint's layout, so
 * both have to be right before the first render rather than applied afterwards. */
export function initialUiOverlay(): { mainView?: 'canvas' | 'embedding'; leftMenuOpen?: boolean } {
  const ui = urlViewOverlay()?.ui;
  return { mainView: ui?.view, leftMenuOpen: ui?.menu };
}

/** True when the link pins a camera, so the canvases can be told to restore it. */
export function urlHasViewport(): boolean {
  const o = urlViewOverlay();
  return !!(o?.sp?.vp || o?.em?.vp);
}

/** Merge the overlay onto the checkpoint's `app_state`, before it reaches the store, so
 * the first paint is already the shared view rather than flashing the saved one.
 * Applied to the first display of each kind — the one the main view renders. */
export function applyOverlayToAppState(app: AppState, overlay: ViewOverlay | null): AppState {
  if (!overlay) return app;
  let spatialDone = false;
  let embeddingDone = false;
  const displays = app.displays.map((d) => {
    if (overlay.sp && !spatialDone && isSpatialDisplay(d)) {
      spatialDone = true;
      return {
        ...d,
        encoding: { ...d.encoding, ...overlay.sp.enc },
        viewport: 'vp' in overlay.sp ? expandViewport(overlay.sp.vp) : d.viewport,
      };
    }
    if (overlay.em && !embeddingDone && isEmbeddingDisplay(d)) {
      embeddingDone = true;
      return {
        ...d,
        encoding: { ...d.encoding, ...overlay.em.enc },
        viewport: 'vp' in overlay.em ? expandViewport(overlay.em.vp) : d.viewport,
      };
    }
    return d;
  });
  return { ...app, displays };
}
