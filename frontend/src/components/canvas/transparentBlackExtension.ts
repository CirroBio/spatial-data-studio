import { LayerExtension } from '@deck.gl/core';

// Fluorescence images composite additively from black (imaging._composite /
// useVivImageLayer's GPU path): color = sum(clip(value/limit, 0, 1) * channelColor).
// That sum IS the per-pixel intensity/coverage, in the same [0, 1] range alpha
// needs — i.e. `color.rgb` here is already a premultiplied-alpha color, just
// missing the alpha channel. A binary "exactly black -> alpha 0, else opaque"
// (the previous approach) makes zero pixels transparent but leaves every other
// pixel fully opaque regardless of how faint, so against a light backdrop you get
// a hard-edged cutout instead of a smooth fade — low-intensity pixels read as
// solid black next to the backdrop's white instead of blending toward it.
//
// The fix: derive alpha from the coverage itself (the largest channel
// contribution, clamped to 1) and un-premultiply the color by it, so standard
// (non-premultiplied) "over" blending — color*alpha + backdrop*(1-alpha) —
// reproduces exactly today's look against a black backdrop (alpha effectively 1
// once any channel saturates) while fading smoothly to the backdrop color as
// intensity drops toward zero, on ANY backdrop color.
//
// Neither deck.gl's BitmapLayer (WebP tile path, useImageTiles.ts) nor Viv's
// XRLayer (useVivImageLayer.ts) has a built-in mechanism for this (BitmapLayer's
// own `transparentColor` prop blends a semi-transparent *source* image with a
// background color — not applicable to an always-opaque composited image), but
// both call DECKGL_FILTER_COLOR(color, geometry) near the end of their fragment
// shader, so one shared extension injected there works for either layer.
//
// True-color RGB images (e.g. H&E) must NOT use this — black there is real
// tissue, not "no signal" — callers only add this extension when the image isn't
// RGB (see `!isRgb` at each call site).
export class TransparentBlackExtension extends LayerExtension {
  static extensionName = 'TransparentBlackExtension';
  getShaders() {
    return {
      inject: {
        'fs:DECKGL_FILTER_COLOR': `
          float coverage = clamp(max(color.r, max(color.g, color.b)), 0.0, 1.0);
          color.rgb = color.rgb / max(coverage, 0.0001);
          color.a *= coverage;
        `,
      },
    };
  }
}

export const transparentBlackExtension = new TransparentBlackExtension();
