import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { CheckpointHandle, SpatialDisplaySpec } from '@cirrobio/spatial-viewer';
import { currentDisplay, setDisplay, showDisplay, takeFit, useDisplays, type Displays } from './displayState';

const TISSUE = {
  type: 'spatial_canvas', title: 'Tissue', viewport: null, encoding: { color_by: null },
} as unknown as SpatialDisplaySpec;

// All that opening a store reads of it here: its display, and no groupings to color by.
const HANDLE = { appState: { displays: [TISSUE] }, fields: { obs: [] }, source: {} } as unknown as CheckpointHandle;

// Opened through its hook, as the page opens it.
async function open(key: string): Promise<SpatialDisplaySpec> {
  const seen: { displays: Displays | null } = { displays: null };
  function Probe() {
    seen.displays = useDisplays(key, HANDLE);
    return null;
  }
  createRoot(document.createElement('div')).render(createElement(Probe));
  await vi.waitFor(() => expect(seen.displays?.spatial).toBeTruthy());
  return seen.displays!.spatial!;
}

describe('showing a figure on the canvas', () => {
  it('fits the canvas again for a figure kept fit to its data, after the camera moved', async () => {
    const key = 'fit-again';
    const tissue = await open(key);
    const figure = currentDisplay(key, tissue);
    expect(figure.viewport).toBeNull();
    setDisplay(key, { ...tissue, viewport: { target: [10, 20], zoom: 3 } });

    showDisplay(key, figure);
    expect(currentDisplay(key, tissue).viewport).toBeNull();
    expect(takeFit(key, 'spatial')).toBe(true);
    expect(takeFit(key, 'spatial')).toBe(false);
  });

  it('moves the canvas to a figure camera of its own without fitting', async () => {
    const key = 'own-camera';
    const tissue = await open(key);
    const viewport = { target: [1, 2] as [number, number], zoom: 4 };

    showDisplay(key, { ...tissue, viewport });
    expect(currentDisplay(key, tissue).viewport).toEqual(viewport);
    expect(takeFit(key, 'spatial')).toBe(false);
  });
});
