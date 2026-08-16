// The share-link encoder is pure, so it is tested directly rather than through the
// browser — the e2e spec covers the wiring (frontend/e2e/serverless-share.spec.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import type { SpatialDisplaySpec, EmbeddingDisplaySpec } from '@cirrobio/spatial-viewer';
import {
  applyOverlayToAppState, buildOverlay, encodeViewOverlay, setViewBaseline, viewHref,
  type CurrentView,
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
  spatial: spatial(), embedding: embedding(), mainView: 'canvas', leftMenuOpen: false, ...over,
});

beforeEach(() => {
  setViewBaseline({ spatial: spatial(), embedding: embedding() });
});

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

  it('carries UI state only when it differs from a fresh viewer', () => {
    expect(buildOverlay(current({ mainView: 'embedding' }))?.ui).toEqual({ view: 'embedding' });
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
