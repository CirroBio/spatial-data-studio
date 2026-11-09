import { describe, expect, it } from 'vitest';
import type { DisplaySpec } from '@cirrobio/spatial-viewer';
import { figureContent } from './spec';

const display = {
  type: 'spatial_canvas', title: 'Tissue',
  encoding: { color_by: 'obs:leiden', point_size: 2 },
  viewport: { target: [120.5, 300.25], zoom: -1.5 },
} as unknown as DisplaySpec;
const figure = (d: DisplaySpec, title = 'Clusters') => ({ title, caption: 'Cells by cluster.', width_mm: 89, view: { kind: 'canvas' as const, display: d } });

describe('figureContent', () => {
  it('is the same for a figure read back from the store, whatever its keys\' order', () => {
    const stored = JSON.parse(JSON.stringify(figure(display))) as ReturnType<typeof figure>;
    expect(figureContent(stored)).toBe(figureContent(figure(display)));
    const reordered = { viewport: display.viewport, encoding: { point_size: 2, color_by: 'obs:leiden', unset: undefined }, title: 'Tissue', type: 'spatial_canvas' };
    expect(figureContent(figure(reordered as unknown as DisplaySpec))).toBe(figureContent(figure(display)));
  });

  it('differs once the camera, the color or the words change', () => {
    const kept = figureContent(figure(display));
    expect(figureContent(figure({ ...display, viewport: { target: [120.5, 301], zoom: -1.5 } }))).not.toBe(kept);
    expect(figureContent(figure({ ...display, encoding: { ...display.encoding, color_by: 'obs:cell_type' } } as DisplaySpec))).not.toBe(kept);
    expect(figureContent(figure(display, 'Clusters, again'))).not.toBe(kept);
    expect(figureContent({ ...figure(display), width_mm: 183 })).not.toBe(kept);
  });
});
