import { describe, expect, it } from 'vitest';
import { fitBounds, fitZoom } from './viewFit';

const square = { d0min: 0, d0max: 100, d1min: 0, d1max: 100 };
// The world x a screen x lands on, for an orthographic camera at `center` and `zoom`.
const worldAt = (screenX: number, pxW: number, center: number, zoom: number) => center + (screenX - pxW / 2) / 2 ** zoom;

describe('fitBounds', () => {
  it('centres the bounds in the whole canvas without an inset', () => {
    const fit = fitBounds(square, 1000, 400)!;
    expect(fit.centerX).toBe(50);
    expect(fit.zoom).toBeCloseTo(fitZoom(100, 100, 1000, 400));
  });

  it('frames the bounds in the strip panels leave clear', () => {
    // A wide extent, so the clear width rather than the height sets the zoom.
    const wide = { d0min: 0, d0max: 1000, d1min: 0, d1max: 100 };
    const fit = fitBounds(wide, 1000, 400, { left: 300, right: 100 })!;
    expect(fit.zoom).toBeCloseTo(fitZoom(1000, 100, 600, 400));
    // The data's centre sits in the middle of the clear strip, x = 300 + 600 / 2.
    expect(worldAt(600, 1000, fit.centerX, fit.zoom)).toBeCloseTo(500);
  });

  it('shifts the other way when the view mirrors x', () => {
    const plain = fitBounds(square, 1000, 400, { left: 300, right: 100 })!;
    const mirrored = fitBounds(square, 1000, 400, { left: 300, right: 100, flipX: true })!;
    expect(mirrored.centerX - 50).toBeCloseTo(50 - plain.centerX);
  });

  it('never fits into less than a third of the canvas', () => {
    const fit = fitBounds({ d0min: 0, d0max: 1000, d1min: 0, d1max: 10 }, 900, 400, { left: 400, right: 400 })!;
    expect(fit.zoom).toBeCloseTo(fitZoom(1000, 10, 300, 400));
  });
});
