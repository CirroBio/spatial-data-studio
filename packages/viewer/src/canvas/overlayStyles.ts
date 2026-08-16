import type { CSSProperties } from 'react';

// Styling for the in-canvas overlays (legends, hints, the minimap, the loading cues).
//
// These are inline styles rather than Tailwind classes because the library ships no
// stylesheet: a Cirro dashboard renders the canvas natively, with none of the Studio
// app's CSS in the page. The app-side control panels (CanvasControls /
// EmbeddingControls) keep their Tailwind — they never leave the app.
//
// Colors resolve through the app's theme tokens when they are defined (index.css sets
// them as space-separated RGB channels and swaps them per theme), so the overlays keep
// following the Studio theme exactly as the Tailwind classes did; the fallback is the
// dark palette, which is what a host without those tokens gets.
const THEME_FALLBACK = {
  bg: '7 11 36',
  surface: '15 26 48',
  border: '30 48 73',
  text: '232 238 243',
  muted: '141 160 176',
  accent: '36 191 211',
  success: '75 143 109',
} as const;

export function themeColor(name: keyof typeof THEME_FALLBACK, alpha = 1): string {
  return `rgb(var(--color-${name}, ${THEME_FALLBACK[name]}) / ${alpha})`;
}

// Tailwind's `font-mono` stack (tailwind.config.js), for the 3D navigation hint.
export const MONO_FONT = "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace";

// Tailwind's shadow-lg / shadow-md.
const SHADOW_LG = '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)';
const SHADOW_MD = '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)';

/** The frosted panel every overlay sits on. */
export const OVERLAY_PANEL: CSSProperties = {
  position: 'absolute',
  background: themeColor('surface', 0.9),
  border: `1px solid ${themeColor('border')}`,
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
};

export const TRUNCATE: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** A legend's color chip. */
export const SWATCH: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 2,
  flexShrink: 0,
  border: `1px solid ${themeColor('border', 0.5)}`,
};

/** One legend row: chip + label. */
export const LEGEND_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  color: themeColor('text'),
};

export const LOADING_CUE: CSSProperties = {
  ...OVERLAY_PANEL,
  top: 12,
  left: 12,
  zIndex: 20,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px',
  borderRadius: 9999,
  background: themeColor('surface', 0.95),
  border: `1px solid ${themeColor('accent', 0.6)}`,
  fontSize: 12,
  lineHeight: '16px',
  color: themeColor('text'),
  boxShadow: SHADOW_LG,
  pointerEvents: 'none',
};

export const TILE_STATUS: CSSProperties = {
  ...OVERLAY_PANEL,
  bottom: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  padding: '8px 12px',
  borderRadius: 8,
  boxShadow: SHADOW_MD,
  pointerEvents: 'none',
};

export const CHANNEL_LEGEND: CSSProperties = {
  ...OVERLAY_PANEL,
  bottom: 12,
  left: 12,
  zIndex: 10,
  borderRadius: 4,
  padding: 8,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  maxWidth: 180,
  pointerEvents: 'none',
};

export const CELL_LEGEND: CSSProperties = {
  ...OVERLAY_PANEL,
  bottom: 12,
  right: 12,
  zIndex: 10,
  borderRadius: 4,
  padding: 8,
  maxWidth: 200,
};

export const DRAW_HINT: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 10,
  padding: '6px 12px',
  borderRadius: 4,
  borderWidth: 1,
  borderStyle: 'solid',
  fontSize: 12,
  lineHeight: '16px',
  letterSpacing: '0.025em',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  background: themeColor('surface', 0.9),
};

/** The "Loading spatial coordinates…" placeholder shown before the first view state. */
export const CANVAS_PLACEHOLDER: CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: themeColor('bg'),
  color: themeColor('muted'),
  fontSize: 14,
  lineHeight: '20px',
};

/** The canvas container the deck.gl surface and every overlay are positioned in. */
export const CANVAS_ROOT: CSSProperties = {
  width: '100%',
  height: '100%',
  position: 'relative',
};
