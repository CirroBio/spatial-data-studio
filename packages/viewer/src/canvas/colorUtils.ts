// 15 distinct colors for categorical data (colorblind-friendly where possible)
export const CATEGORY_COLORS: [number, number, number][] = [
  [86, 180, 233],
  [230, 159, 0],
  [0, 158, 115],
  [240, 228, 66],
  [0, 114, 178],
  [213, 94, 0],
  [204, 121, 167],
  [153, 153, 153],
  [255, 127, 14],
  [44, 160, 44],
  [214, 39, 40],
  [148, 103, 189],
  [140, 86, 75],
  [227, 119, 194],
  [188, 189, 34],
];

// Canonical 8-color channel palette: ColorBrewer/matplotlib "Set1", the standard
// qualitative cycle used across scientific plotting (R, Python, ggplot2). Mirrors
// backend/app/imaging.py DEFAULT_CHANNEL_COLORS so a channel's default color here
// matches what the server composites into the thumbnail.
export const CHANNEL_COLORS: string[] = [
  '#e41a1c', // red
  '#377eb8', // blue
  '#4daf4a', // green
  '#984ea3', // purple
  '#ff7f00', // orange
  '#ffff33', // yellow
  '#a65628', // brown
  '#f781bf', // pink
];

export function defaultChannelColor(index: number): string {
  return CHANNEL_COLORS[index % CHANNEL_COLORS.length];
}

// Format an RGB triple as a `#rrggbb` string — the value `<input type="color">`
// expects and the shape a persisted category-color override stores.
export function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// The categorical palette as hex preset swatches, for ColorSwatchPicker in the
// per-category color controls (mirrors CHANNEL_COLORS for the channel controls).
export const CATEGORY_SWATCHES: string[] = CATEGORY_COLORS.map(rgbToHex);

// Parse a `#rrggbb` string to an RGB triple, falling back to white on a malformed
// value. Shared by every canvas layer that reads a persisted hex color (channel
// tints, shape-annotation strokes/fills).
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = Number.parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Per-plot backdrop colors, matching --color-bg for each theme (index.css). The deck
// canvas is transparent, so this paints the container behind it on the live canvas.
// Mirrors backend/app/snapshots.py PLOT_BACKGROUNDS so an exported figure matches.
export const PLOT_BACKGROUNDS: Record<'light' | 'dark', string> = {
  dark: 'rgb(7 11 36)',
  light: 'rgb(250 251 252)',
};

// Lasso/selection overlay colors, shared by the spatial and embedding canvases. These
// are UI chrome drawn over the plot, so they follow the theme tokens — success for
// region labeling, accent for subsetting — not the data palettes above. Keyed by the
// backdrop they sit on (the plot's own for the spatial canvas, the app theme for the
// embedding one), since the accent is the bright brand teal on dark and the deeper
// teal on light.
export const SELECTION_COLORS: Record<
  'light' | 'dark',
  Record<'regions' | 'subset', [number, number, number]>
> = {
  dark: { regions: [75, 143, 109], subset: [36, 191, 211] },
  light: { regions: [46, 125, 85], subset: [14, 124, 160] },
};

/**
 * Build a map from category value (string) to RGB triple.
 * Categories are sorted for stable assignment.
 */
export function buildCategoricalPalette(
  categories: string[]
): Map<string, [number, number, number]> {
  const sorted = [...categories].sort();
  const map = new Map<string, [number, number, number]>();
  sorted.forEach((cat, i) => {
    map.set(cat, CATEGORY_COLORS[i % CATEGORY_COLORS.length]);
  });
  return map;
}

// Viridis colormap (256 entries), the table backend/app/snapshots.py's `_viridis_lut`
// rebuilds from matplotlib at the same stops, so an exported figure and the canvas
// give a numeric value the same color.
const VIRIDIS: [number, number, number][] = [
  [68,1,84],[68,2,86],[69,4,87],[69,5,89],[70,7,90],[70,8,92],[70,10,93],[70,11,94],
  [71,13,96],[71,14,97],[71,16,99],[71,17,100],[71,19,101],[72,20,103],[72,22,104],[72,23,105],
  [72,24,106],[72,26,108],[72,27,109],[72,28,110],[72,29,111],[72,31,112],[72,32,113],[72,33,115],
  [72,35,116],[72,36,117],[72,37,118],[72,38,119],[72,40,120],[72,41,121],[71,42,122],[71,44,122],
  [71,45,123],[71,46,124],[71,47,125],[70,48,126],[70,50,126],[70,51,127],[70,52,128],[69,53,129],
  [69,55,129],[69,56,130],[68,57,131],[68,58,131],[68,59,132],[67,61,132],[67,62,133],[66,63,133],
  [66,64,134],[66,65,134],[65,66,135],[65,68,135],[64,69,136],[64,70,136],[63,71,136],[63,72,137],
  [62,73,137],[62,74,137],[62,76,138],[61,77,138],[61,78,138],[60,79,138],[60,80,139],[59,81,139],
  [59,82,139],[58,83,139],[58,84,140],[57,85,140],[57,86,140],[56,88,140],[56,89,140],[55,90,140],
  [55,91,141],[54,92,141],[54,93,141],[53,94,141],[53,95,141],[52,96,141],[52,97,141],[51,98,141],
  [51,99,141],[50,100,142],[50,101,142],[49,102,142],[49,103,142],[49,104,142],[48,105,142],[48,106,142],
  [47,107,142],[47,108,142],[46,109,142],[46,110,142],[46,111,142],[45,112,142],[45,113,142],[44,113,142],
  [44,114,142],[44,115,142],[43,116,142],[43,117,142],[42,118,142],[42,119,142],[42,120,142],[41,121,142],
  [41,122,142],[41,123,142],[40,124,142],[40,125,142],[39,126,142],[39,127,142],[39,128,142],[38,129,142],
  [38,130,142],[38,130,142],[37,131,142],[37,132,142],[37,133,142],[36,134,142],[36,135,142],[35,136,142],
  [35,137,142],[35,138,141],[34,139,141],[34,140,141],[34,141,141],[33,142,141],[33,143,141],[33,144,141],
  [33,145,140],[32,146,140],[32,146,140],[32,147,140],[31,148,140],[31,149,139],[31,150,139],[31,151,139],
  [31,152,139],[31,153,138],[31,154,138],[30,155,138],[30,156,137],[30,157,137],[31,158,137],[31,159,136],
  [31,160,136],[31,161,136],[31,161,135],[31,162,135],[32,163,134],[32,164,134],[33,165,133],[33,166,133],
  [34,167,133],[34,168,132],[35,169,131],[36,170,131],[37,171,130],[37,172,130],[38,173,129],[39,173,129],
  [40,174,128],[41,175,127],[42,176,127],[44,177,126],[45,178,125],[46,179,124],[47,180,124],[49,181,123],
  [50,182,122],[52,182,121],[53,183,121],[55,184,120],[56,185,119],[58,186,118],[59,187,117],[61,188,116],
  [63,188,115],[64,189,114],[66,190,113],[68,191,112],[70,192,111],[72,193,110],[74,193,109],[76,194,108],
  [78,195,107],[80,196,106],[82,197,105],[84,197,104],[86,198,103],[88,199,101],[90,200,100],[92,200,99],
  [94,201,98],[96,202,96],[99,203,95],[101,203,94],[103,204,92],[105,205,91],[108,205,90],[110,206,88],
  [112,207,87],[115,208,86],[117,208,84],[119,209,83],[122,209,81],[124,210,80],[127,211,78],[129,211,77],
  [132,212,75],[134,213,73],[137,213,72],[139,214,70],[142,214,69],[144,215,67],[147,215,65],[149,216,64],
  [152,216,62],[155,217,60],[157,217,59],[160,218,57],[162,218,55],[165,219,54],[168,219,52],[170,220,50],
  [173,220,48],[176,221,47],[178,221,45],[181,222,43],[184,222,41],[186,222,40],[189,223,38],[192,223,37],
  [194,223,35],[197,224,33],[200,224,32],[202,225,31],[205,225,29],[208,225,28],[210,226,27],[213,226,26],
  [216,226,25],[218,227,25],[221,227,24],[223,227,24],[226,228,24],[229,228,25],[231,228,25],[234,229,26],
  [236,229,27],[239,229,28],[241,229,29],[244,230,30],[246,230,32],[248,230,33],[251,231,35],[253,231,37],
];

// CSS gradient mirroring the viridis ramp used by buildNumericColormap, for the
// numeric color legend's colorbar.
export const VIRIDIS_CSS_GRADIENT = `linear-gradient(to right, ${VIRIDIS.map(
  ([r, g, b]) => `rgb(${r},${g},${b})`,
).join(',')})`;

/**
 * Build RGBA Uint8Array for N points, mapping normalized values to viridis colormap.
 * values: Float64Array or Float32Array with raw values
 * Returns Uint8Array of length N*4 (RGBA)
 */
export function buildNumericColormap(
  values: Float32Array | Float64Array
): Uint8Array {
  const n = values.length;
  const result = new Uint8Array(n * 4);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!isNaN(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const range = max - min;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isNaN(v)) {
      result[i * 4 + 3] = 0;
      continue;
    }
    const t = range === 0 ? 0.5 : Math.max(0, Math.min(1, (v - min) / range));
    const idx = Math.min(255, Math.floor(t * 255));
    const [r, g, b] = VIRIDIS[idx];
    result[i * 4] = r;
    result[i * 4 + 1] = g;
    result[i * 4 + 2] = b;
    result[i * 4 + 3] = 255;
  }
  return result;
}
