// The share-link encoder is pure, so it is tested directly rather than through the
// browser — the e2e spec covers the wiring (frontend/e2e/serverless-share.spec.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpatialDisplaySpec, EmbeddingDisplaySpec } from '@cirrobio/spatial-viewer';
import {
  applyOverlayToAppState, buildOverlay, encodeViewOverlay, setViewBaseline, viewHref,
  type CurrentView, type ViewOverlay,
} from './urlViewState';
import type { AppState } from '../types';

const spatial = (over: Partial<SpatialDisplaySpec['encoding']> = {},
                 viewport: SpatialDisplaySpec['viewport'] = null): SpatialDisplaySpec => ({
  id: 'sp1',
  type: 'spatial_canvas',
  encoding: {
    coords: 'obsm:spatial', color_by: 'obs:cell_type', image_layer: 'section',
    shapes_layer: null, point_size: 4, opacity: 0.85, colormap: 'viridis', ...over,
  },
  viewport,
});

const embedding = (over: Partial<EmbeddingDisplaySpec['encoding']> = {},
                   viewport: EmbeddingDisplaySpec['viewport'] = null): EmbeddingDisplaySpec => ({
  id: 'em1',
  type: 'embedding_canvas',
  encoding: {
    obsm_key: 'X_umap', x_component: 0, y_component: 1, z_component: 2, is_3d: false,
    color_by: 'obs:cell_type', point_size: 4, opacity: 0.85, colormap: 'viridis', ...over,
  },
  viewport,
});

const current = (over: Partial<CurrentView> = {}): CurrentView => ({
  spatial: spatial(), embedding: embedding(), mainView: 'canvas', leftMenuOpen: false,
  expandedPlotId: null, ...over,
});

beforeEach(() => {
  setViewBaseline({ spatial: spatial(), embedding: embedding() });
});

/** Put `overlay` on a link and read it back the way a recipient's browser does — over
 * `location.search` and through the zod schema, which is where a field the schema does
 * not name is dropped. `readUrl` memoizes for the life of the page, so each link needs
 * its own module instance. */
async function throughLink(overlay: ViewOverlay | null) {
  window.history.replaceState(
    null, '', `/?checkpoint=demo.zarr.zip&view=${encodeViewOverlay(overlay)}`,
  );
  vi.resetModules();
  const reader = await import('./urlViewState');
  return { overlay: reader.urlViewOverlay(), malformed: reader.urlViewMalformed() };
}

describe('buildOverlay', () => {
  it('is null when nothing differs from the checkpoint', () => {
    expect(buildOverlay(current())).toBeNull();
  });

  it('treats an absent field and its default as equal', () => {
    // The baseline leaves these unset; setting them to their own defaults is not a change.
    expect(buildOverlay(current({
      spatial: spatial({ point_marker: 'circle', background: 'dark', legend_visible: true }),
    }))).toBeNull();
  });

  it('carries only the fields that changed', () => {
    const overlay = buildOverlay(current({ spatial: spatial({ colormap: 'magma', point_size: 9 }) }));
    expect(overlay?.sp?.enc).toEqual({ colormap: 'magma', point_size: 9 });
    expect(overlay?.em).toBeUndefined();
  });

  it('resolves show_image against the current image_layer, not a constant', () => {
    // Default is "on when there is an image", so dropping the layer is one change, not two.
    const overlay = buildOverlay(current({ spatial: spatial({ image_layer: null }) }));
    expect(overlay?.sp?.enc).toEqual({ image_layer: null, show_image: false });
  });

  it('replaces nested maps wholesale rather than merging keys', () => {
    setViewBaseline({
      spatial: spatial({ category_colors: { 'obs:cell_type': { Tumor: '#ff0000' } } }),
      embedding: embedding(),
    });
    const overlay = buildOverlay(current({
      spatial: spatial({ category_colors: { 'obs:cell_type': { Stroma: '#00ff00' } } }),
    }));
    expect(overlay?.sp?.enc?.category_colors).toEqual({ 'obs:cell_type': { Stroma: '#00ff00' } });
  });

  it('ignores key order inside nested maps', () => {
    const colors = { 'obs:cell_type': { Tumor: '#ff0000', Stroma: '#00ff00' } };
    const reordered = { 'obs:cell_type': { Stroma: '#00ff00', Tumor: '#ff0000' } };
    setViewBaseline({ spatial: spatial({ category_colors: colors }), embedding: embedding() });
    expect(buildOverlay(current({ spatial: spatial({ category_colors: reordered }) }))).toBeNull();
  });

  it('carries the camera, including 3-D rotation', () => {
    const overlay = buildOverlay(current({
      spatial: spatial({}, { target: [512, 512], zoom: -0.76 }),
      embedding: embedding({ is_3d: true }, { target: [1, 2, 3], zoom: 2, rotationX: 25, rotationOrbit: 40 }),
    }));
    expect(overlay?.sp?.vp).toEqual({ t: [512, 512], z: -0.76 });
    expect(overlay?.em?.vp).toEqual({ t: [1, 2, 3], z: 2, rx: 25, ro: 40 });
  });

  it('emits nothing for a field the current encoding dropped', () => {
    // `isolated_category` has no entry in SPATIAL_ENCODING_DEFAULTS, so dropping it
    // leaves the normalized value `undefined` — and `stableJson` omits undefined, so
    // emitting the key would build a `view` parameter that encodes to `{"sp":{"enc":{}}}`
    // and applies nothing. The delta has no tombstone for a removal.
    setViewBaseline({ spatial: spatial({ isolated_category: 'Tumor' }), embedding: embedding() });
    expect(buildOverlay(current())).toBeNull();
    // Alongside a real change the dropped key must be absent, not present-and-undefined:
    // toStrictEqual, because toEqual would accept the undefined key that is the bug.
    const overlay = buildOverlay(current({ spatial: spatial({ colormap: 'magma' }) }));
    expect(overlay?.sp?.enc).toStrictEqual({ colormap: 'magma' });
  });

  it('carries UI state only when it differs from a fresh viewer', () => {
    expect(buildOverlay(current({ mainView: 'embedding' }))?.ui).toEqual({ view: 'embedding' });
    // The plot gallery reads figures out of the checkpoint, so it is shareable — as is
    // the plot the link opens fullscreen.
    expect(buildOverlay(current({ mainView: 'plots' }))?.ui).toEqual({ view: 'plots' });
    expect(buildOverlay(current({ mainView: 'plots', expandedPlotId: 'plot-7' }))?.ui)
      .toEqual({ view: 'plots', plot: 'plot-7' });
    expect(buildOverlay(current({ leftMenuOpen: true }))?.ui).toEqual({ menu: true });
    // Tables is backend-only, so it never reaches a shared link.
    expect(buildOverlay(current({ mainView: 'tables' }))).toBeNull();
  });
});

describe('round trip', () => {
  const app = (): AppState => ({
    schema_version: 3, compute_history: [], plots: [], data_versions: {}, regions: [],
    displays: [spatial(), embedding()],
  } as unknown as AppState);

  it('applies an overlay onto the checkpoint app_state', () => {
    const overlay = buildOverlay(current({
      spatial: spatial({ colormap: 'magma' }, { target: [10, 20], zoom: 3 }),
    }));
    const next = applyOverlayToAppState(app(), overlay);
    const sp = next.displays[0] as SpatialDisplaySpec;
    expect(sp.encoding.colormap).toBe('magma');
    expect(sp.viewport).toEqual({ target: [10, 20], zoom: 3 });
    // Untouched fields still come from the file.
    expect(sp.encoding.color_by).toBe('obs:cell_type');
  });

  it('leaves app_state alone for a null overlay', () => {
    const original = app();
    expect(applyOverlayToAppState(original, null)).toBe(original);
  });

  // `.partial()` strips a key the schema does not name rather than rejecting it, so a
  // field the diff emits but the schema omits vanishes on decode and the link is not
  // even reported malformed. These two were exactly that: settable in the UI, emitted
  // into the payload, absent from both schemas.
  it('carries legend_scale on both canvases', async () => {
    const link = await throughLink(buildOverlay(current({
      spatial: spatial({ legend_scale: 1.5 }), embedding: embedding({ legend_scale: 2 }),
    })));
    expect(link.malformed).toBe(false);
    expect(link.overlay?.sp?.enc).toEqual({ legend_scale: 1.5 });
    expect(link.overlay?.em?.enc).toEqual({ legend_scale: 2 });
    const next = applyOverlayToAppState(app(), link.overlay);
    expect((next.displays[0] as SpatialDisplaySpec).encoding.legend_scale).toBe(1.5);
    expect((next.displays[1] as EmbeddingDisplaySpec).encoding.legend_scale).toBe(2);
  });

  it('carries lock_view on both canvases', async () => {
    const link = await throughLink(buildOverlay(current({
      spatial: spatial({ lock_view: true }), embedding: embedding({ lock_view: true }),
    })));
    expect(link.malformed).toBe(false);
    expect(link.overlay?.sp?.enc).toEqual({ lock_view: true });
    expect(link.overlay?.em?.enc).toEqual({ lock_view: true });
    const next = applyOverlayToAppState(app(), link.overlay);
    expect((next.displays[0] as SpatialDisplaySpec).encoding.lock_view).toBe(true);
    expect((next.displays[1] as EmbeddingDisplaySpec).encoding.lock_view).toBe(true);
  });

  it('survives encode', () => {
    const overlay = buildOverlay(current({
      spatial: spatial({ legend_title: 'Zelltyp — Übersicht ✓' }),  // non-ASCII must not corrupt
    }));
    const encoded = encodeViewOverlay(overlay)!;
    expect(encoded).not.toMatch(/[+/=]/);  // base64url
    const decoded = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
    ));
    expect(decoded.sp.enc.legend_title).toBe('Zelltyp — Übersicht ✓');
  });
});

// `?background=` states what an embedding page wants the canvas to open on. It is
// folded in before the baseline is captured, so `view=` — the reader's own delta — has
// to win over it, and a link copied inside the frame carries only the difference.
describe('applyBackgroundFromUrl', () => {
  const app = (): AppState => ({
    schema_version: 3, compute_history: [], plots: [], data_versions: {}, regions: [],
    displays: [spatial(), embedding()],
  } as unknown as AppState);

  /** Re-import against a given URL — the param is read once, off `location.search`. */
  async function at(search: string) {
    window.history.replaceState(null, '', search);
    vi.resetModules();
    return import('./urlViewState');
  }

  it('sets the spatial background from the parameter', async () => {
    const { applyBackgroundFromUrl } = await at('/?checkpoint=demo.zarr.zip&background=light');
    const next = applyBackgroundFromUrl(app());
    expect((next.displays[0] as SpatialDisplaySpec).encoding.background).toBe('light');
  });

  it('leaves app_state alone when absent or not light/dark', async () => {
    const original = app();
    const none = await at('/?checkpoint=demo.zarr.zip');
    expect(none.applyBackgroundFromUrl(original)).toBe(original);
    const junk = await at('/?checkpoint=demo.zarr.zip&background=chartreuse');
    expect(junk.applyBackgroundFromUrl(original)).toBe(original);
  });
});

describe('viewHref', () => {
  it('preserves the other parameters and removes view when empty', () => {
    window.history.replaceState(null, '', '/?checkpoint=demo.zarr.zip&embed=1');
    const withView = viewHref('abc');
    expect(new URL(withView, location.origin).searchParams.get('checkpoint')).toBe('demo.zarr.zip');
    expect(new URL(withView, location.origin).searchParams.get('embed')).toBe('1');
    expect(new URL(withView, location.origin).searchParams.get('view')).toBe('abc');
    expect(new URL(viewHref(null), location.origin).searchParams.has('view')).toBe(false);
  });
});
