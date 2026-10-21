import { useEffect, useRef } from 'react';

// The landing page's backdrop: a tissue section of a few thousand cells, only stained
// (H&E in the light theme, a nuclear stain in the dark).
//
// The pointer is a microscope's lens. Under it the section is magnified to
// single cells, drawn as their segmentation outlines and colored by neighborhood the way
// Xenium sections look in the app. The section is one of five tissues at a time: each
// new look through the lens shows the next, and a long look turns over to it cell by
// cell every few seconds. The five are a pancreas (acinar lobules,
// islets ringed by another neighborhood, ducts around their lumens), a lymph node
// (follicles with germinal centres in a T-cell zone, sinuses, medullary cords), a colon
// (crypts cut across, in lamina propria, over muscle), a cortex (layers of neurons over
// white matter, threaded by vessels) and a tumour (nests of tumour cells in stroma,
// immune cells at their margins, dead cores in the largest). The detail is a field over
// the page, so moving the lens pans across the section. Moving the lens parts the dots
// in its wake, and a click sends a ripple through them. Drawn with WebGL2; still under
// reduced motion (each look still shows the next tissue, but nothing turns, and the lens
// follows the pointer without easing); absent without WebGL2, since it only decorates.

const N = 5200;
const TISSUES = 5;
// How long the section shows each tissue, and how long it takes to turn to the next.
const TISSUE_MS = 7000;
const TURN_MS = 1600;
const WAKE = 12;
const CELL_PX = 4.2;
// How fast the lens catches up with the pointer, and how long the wake lasts (seconds).
const FOLLOW = 14;
const WAKE_FADE = 0.55;
const PULSE_S = 1.6;
// The lens fades away this long after the pointer stops, and comes into focus over this
// long when it appears.
const IDLE_MS = 2600;
const FOCUS_MS = 420;

// Seeded so the picture is the same on every visit.
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per cell: x, y and a random seed, inside a section shaped like a tissue slice (an
 * irregular ellipse). */
function makeCells(): Float32Array {
  const rnd = random(7);
  const cells = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    let x = 0;
    let y = 0;
    for (;;) {
      x = (rnd() * 2 - 1) * 1.3;
      y = (rnd() * 2 - 1) * 0.95;
      const wobble = 1 + 0.12 * Math.sin(5 * Math.atan2(y, x));
      if ((x / 1.25) ** 2 + (y / 0.88) ** 2 < wobble) break;
    }
    cells.set([x, y, rnd()], i * 3);
  }
  return cells;
}

const CELL_VERTEX = `#version 300 es
in vec2 aTissue;
in float aSeed;
uniform vec2 uView;
uniform float uScale;
uniform float uTime;
uniform vec3 uWake[${WAKE}];
uniform vec4 uPulse;
uniform vec4 uHush;
uniform vec3 uStain[2];
uniform float uPx;
out vec3 vColor;
out float vAlpha;

void main() {
  float s = aSeed * 6.2831;
  vec2 w = aTissue + 0.006 * vec2(sin(uTime * 0.7 + s), cos(uTime * 0.6 + s * 1.3));
  vec2 p = uView * 0.5 + w * uScale;
  // The lens's wake: cells part around where it has just been, then settle back.
  for (int i = 0; i < ${WAKE}; i++) {
    vec2 d = p - uWake[i].xy;
    p += normalize(d + 1e-4) * uWake[i].z * exp(-dot(d, d) / 1800.0) * 22.0;
  }
  // A click: one ring running outward.
  if (uPulse.w > 0.0) {
    vec2 d = p - uPulse.xy;
    float r = length(d);
    float k = exp(-pow((r - uPulse.z * 520.0) / 28.0, 2.0)) * exp(-uPulse.z * 2.4);
    p += d / max(r, 1.0) * k * 16.0;
  }
  vColor = mix(uStain[0], uStain[1], fract(aSeed * 7.31));
  // Quiet behind the words in the middle.
  float hush = 1.0 - smoothstep(0.34, 1.0, length((p - uHush.xy) / uHush.zw));
  vAlpha = (1.0 - hush) * 0.42;
  gl_PointSize = uPx;
  gl_Position = vec4((p / uView * 2.0 - 1.0) * vec2(1.0, -1.0), 0.0, 1.0);
}`;

const CELL_FRAGMENT = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vAlpha;
out vec4 outColor;
void main() {
  float a = smoothstep(0.5, 0.42, length(gl_PointCoord - 0.5)) * vAlpha;
  outColor = vec4(vColor * a, a);
}`;

const LENS_VERTEX = `#version 300 es
in vec2 aCorner;
uniform vec2 uView;
uniform vec3 uLens;
uniform float uLensR;
out vec2 vLocal;
void main() {
  vLocal = aCorner * (uLensR + 24.0);
  vec2 p = uLens.xy + vLocal;
  gl_Position = vec4((p / uView * 2.0 - 1.0) * vec2(1.0, -1.0), 0.0, 1.0);
}`;

// The hues the magnified tissue's neighborhoods are drawn in, in the order of uHues.
const HUES = ['teal', 'plum', 'green', 'navy', 'rose', 'slate', 'violet'] as const;

// Under the glass: the section magnified to its cells (see the header), and over it the
// glass itself, a thin rim in the accent color, a soft glow, a prismatic fringe either
// side of the rim and a faint highlight on the upper left. Cells are a jittered Voronoi
// tiling, each cell inset from its neighbours, its corners rounded and its body trimmed
// to an ellipse: a near-circle leaves a packed polygon, a slim one a stromal cell. What
// a cell is comes from fields evaluated at its site, so a cell is one color throughout.
const LENS_FRAGMENT = `#version 300 es
// highp: world positions run to a thousand cells, past what mediump resolves.
precision highp float;
in vec2 vLocal;
uniform vec2 uView;
uniform vec3 uLens;
uniform float uLensR;
uniform float uScale;
uniform float uTime;
uniform float uFocus;
uniform float uDpr;
uniform vec3 uAccent;
uniform vec3 uBg;
uniform vec3 uHues[${HUES.length}];
// The tissue the section shows, the one it is turning to, and how far it has turned.
uniform int uTissue;
uniform int uNext;
uniform float uTurn;
uniform vec4 uHush;
out vec4 outColor;

// A cell's width at the lens's centre (CSS px), and how much the lens magnifies the page.
const float CELL_PX = 8.5;
const float MAG = 4.0;
const float PAGE_PER_CELL = CELL_PX / MAG;
const float GAP = 0.05;
const float LINE_PX = 1.15;
const int NONE = -1, TEAL = 0, PLUM = 1, GREEN = 2, NAVY = 3, ROSE = 4, SLATE = 5, VIOLET = 6;
const int PANCREAS = 0, LYMPH_NODE = 1, COLON = 2, CORTEX = 3, TUMOUR = 4;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float noise(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 x) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(x);
    x = x * 2.03 + 17.1;
    a *= 0.5;
  }
  return v / 0.9375;
}
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// A cell's site within its grid square; cells breathe a little.
vec2 site(vec2 g) {
  vec2 h = hash22(g);
  return 0.1 + 0.8 * h + 0.03 * sin(uTime * 0.7 + 6.2831 * h.yx);
}

// Distance (in its own units) from x to the nearest border of a fixed Voronoi tiling.
float border(vec2 x) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  vec2 mg = vec2(0);
  vec2 mr = vec2(0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(i, j);
    vec2 r = g + 0.1 + 0.8 * hash22(n + g + 91.0) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  md = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(i, j);
    vec2 r = g + 0.1 + 0.8 * hash22(n + g + 91.0) - f;
    if (dot(mr - r, mr - r) > 1e-5) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return md;
}

// The heading along the isolines of a noise field at p (in its own units): the grain
// that slim cells line up with.
float grain(vec2 p) {
  float gx = noise(p + vec2(0.04, 0)) - noise(p - vec2(0.04, 0));
  float gy = noise(p + vec2(0, 0.04)) - noise(p - vec2(0, 0.04));
  return atan(gx, -gy);
}

// What the cell at site s is: its hue (NONE for no cell), its half-widths across and
// along, its heading, and whether it belongs to a lobule that septa cut.
struct Cell { int hue; vec2 radii; float heading; bool lobular; };

// Slim cells streaming with the grain, most slim and some rounder.
Cell stromal(Cell c, int hue, vec2 grainAt, float h) {
  c.hue = hue;
  c.heading = grain(grainAt) + 0.35 * (fract(h * 5.7) - 0.5);
  c.radii = fract(h * 2.9) < 0.25 ? vec2(0.4, 0.5) : vec2(0.2 + 0.14 * fract(h * 9.1), 0.6 + 0.35 * fract(h * 4.3));
  return c;
}

// Acinar lobules (teal) with islets, a plum core in a green rim; ducts (navy) in ribbons,
// the larger ones walls around a lumen with a rose sheath; violet immune aggregates; slate
// stroma between.
Cell pancreas(Cell c, vec2 w, float h) {
  float paren = smoothstep(0.525, 0.55, fbm(w / 55.0));
  if (h < paren) {
    vec2 ig = floor(w / 40.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = ig + vec2(i, j);
      float hh = hash12(g + 5.0);
      if (hh < 0.5) continue;
      vec2 d = w - (g + 0.2 + 0.6 * hash22(g + 31.0)) * 40.0;
      float rad = 4.5 + 4.5 * hash12(g + 9.0);
      float a = atan(d.y, d.x);
      float rr = length(d) / (rad * (1.0 + 0.2 * sin(3.0 * a + hh * 20.0) + 0.1 * sin(5.0 * a + hh * 7.0)));
      if (rr < 1.0) { c.hue = PLUM; c.radii *= 1.08; return c; }
      if (rr < 1.0 + 2.4 / rad) { c.hue = GREEN; return c; }
    }
    c.hue = TEAL;
    c.lobular = true;
    return c;
  }
  float ridge = abs(noise(w / 34.0 + 40.0) - 0.5);
  if (noise(w / 60.0 + 11.0) > 0.55) {
    if (ridge < 0.03) return c;
    if (ridge < 0.085) { c.hue = noise(w / 50.0 + 3.0) > 0.55 ? ROSE : NAVY; c.radii *= vec2(0.95, 0.88); return c; }
  } else if (ridge < 0.045) {
    c.hue = NAVY;
    return c;
  }
  if (noise(w / 7.0 + 70.0) > 0.8) { c.hue = VIOLET; c.radii = vec2(0.5, 0.46); return c; }
  if (h > paren + (1.0 - paren) * 0.5) return c;
  return stromal(c, h > 0.97 ? VIOLET : SLATE, w / 40.0, h);
}

// Follicles of small B cells (violet), the larger ones around a germinal centre of bigger
// cells (plum), in a dense T-cell zone (green) with macrophages (rose); sinuses, open
// channels lined by slim cells (slate); and toward the medulla, cords of plasma cells (teal).
Cell lymphNode(Cell c, vec2 w, float h) {
  vec2 fg = floor(w / 34.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = fg + vec2(i, j);
    float hh = hash12(g + 15.0);
    if (hh < 0.3) continue;
    vec2 d = w - (g + 0.2 + 0.6 * hash22(g + 41.0)) * 34.0;
    float rad = 8.0 + 5.0 * hash12(g + 19.0);
    float rr = length(d) / (rad * (1.0 + 0.12 * sin(3.0 * atan(d.y, d.x) + hh * 30.0)));
    if (rr < 0.55 && hh > 0.5) { c.hue = PLUM; c.radii = vec2(0.64, 0.6); return c; }
    if (rr < 1.0) { c.hue = VIOLET; c.radii = vec2(0.44, 0.42); return c; }
  }
  float ridge = abs(noise(w / 28.0 + 80.0) - 0.5);
  if (ridge < 0.025) return c;
  if (ridge < 0.05) {
    if (h > 0.5) return c;
    return stromal(c, SLATE, w / 28.0 + 80.0, h);
  }
  if (fbm(w / 70.0 + 3.0) > 0.6) { c.hue = TEAL; c.radii = vec2(0.56, 0.5); return c; }
  c.hue = h > 0.96 ? ROSE : GREEN;
  c.radii = h > 0.96 ? vec2(0.7, 0.66) : vec2(0.45, 0.43);
  return c;
}

// Crypts cut across: a ring of tall epithelial cells (navy) pointing out from a lumen,
// goblet cells (rose) among them; lamina propria between, loose stroma (slate) with immune
// cells (violet, plum); and a band of long muscle cells (green).
Cell colon(Cell c, vec2 w, float h) {
  if (fbm(w / 90.0 + 21.0) > 0.64) {
    c.hue = GREEN;
    c.heading = grain(w / 60.0 + 21.0) + 0.15 * (fract(h * 5.7) - 0.5);
    c.radii = vec2(0.22, 0.9);
    return c;
  }
  vec2 cg = floor(w / 11.0);
  float best = 9.0;
  vec2 outward = vec2(0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = cg + vec2(i, j);
    vec2 d = w - (g + 0.3 + 0.4 * hash22(g + 51.0)) * 11.0;
    if (length(d) < best) { best = length(d); outward = d; }
  }
  if (best < 1.7) return c;
  if (best < 3.6) {
    c.heading = atan(outward.y, outward.x);
    if (fract(h * 11.3) < 0.18) { c.hue = ROSE; c.radii = vec2(0.5, 0.55); }
    else { c.hue = NAVY; c.radii = vec2(0.32, 0.78); }
    return c;
  }
  if (h > 0.55) return c;
  if (h < 0.26) { c.hue = h < 0.2 ? VIOLET : PLUM; c.radii = vec2(0.42, 0.4); return c; }
  return stromal(c, SLATE, w / 30.0, h);
}

// Layers parallel to the surface, folding back like gyri: a sparse first layer of glia
// (slate), dense small neurons (teal), a denser granular layer, sparse large pyramidal
// neurons pointing to the surface, then white matter, rows of oligodendrocytes (violet)
// with glia. Vessels (rose) thread through.
Cell cortex(Cell c, vec2 w, float h) {
  if (abs(noise(w / 24.0 + 60.0) - 0.5) < 0.018) {
    c.hue = ROSE;
    c.heading = grain(w / 24.0 + 60.0);
    c.radii = vec2(0.22, 0.8);
    return c;
  }
  float layer = mod(w.y * 0.8 + w.x * 0.35 + 22.0 * fbm(w / 120.0 + 5.0), 100.0) / 100.0;
  if (layer < 0.06) {
    if (h > 0.3) return c;
    c.hue = SLATE;
    c.radii = vec2(0.3, 0.28);
    return c;
  }
  if (layer > 0.78) {
    if (h > 0.5) return c;
    c.hue = h < 0.35 ? VIOLET : SLATE;
    c.heading = grain(w / 50.0 + 7.0);
    c.radii = vec2(0.3, 0.4);
    return c;
  }
  float density = layer < 0.3 ? 0.75 : layer < 0.42 ? 0.9 : layer < 0.62 ? 0.45 : 0.65;
  float size = layer < 0.3 ? 0.55 : layer < 0.42 ? 0.45 : layer < 0.62 ? 0.74 : 0.58;
  if (h > density) return c;
  if (h > density * 0.7) { c.hue = SLATE; c.radii = vec2(0.3, 0.28); return c; }
  c.hue = TEAL;
  c.heading = 1.14 + 0.3 * (fract(h * 5.7) - 0.5);
  c.radii = vec2(size * 0.8, size);
  return c;
}

// Nests of large, irregular tumour cells (plum), dead at the heart of the largest, a
// margin of immune cells (violet) around them, and stroma (slate) wrapped between,
// with a few vessels (rose).
Cell tumour(Cell c, vec2 w, float h) {
  vec2 tg = floor(w / 20.0);
  float f1 = 9.0;
  vec2 away = vec2(0);
  float big = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = tg + vec2(i, j);
    vec2 d = w - (g + 0.15 + 0.7 * hash22(g + 71.0)) * 20.0;
    if (length(d) < f1) { f1 = length(d); away = d; big = hash12(g + 73.0); }
  }
  float rr = f1 / ((6.0 + 4.0 * big) * (1.0 + 0.2 * noise(w / 5.0)));
  if (rr < 1.0) {
    if (big > 0.7 && rr < 0.35) {
      if (h > 0.15) return c;
      c.hue = ROSE;
      c.radii = vec2(0.25, 0.22);
      return c;
    }
    c.hue = PLUM;
    c.radii = vec2(0.76, 0.7) + 0.08 * vec2(fract(h * 7.3), fract(h * 3.1));
    return c;
  }
  if (rr < 1.25) {
    if (h > 0.7) return c;
    c.hue = VIOLET;
    c.radii = vec2(0.42, 0.4);
    return c;
  }
  if (h > 0.5) return c;
  c.hue = h < 0.04 ? ROSE : SLATE;
  c.heading = atan(away.y, away.x) + 1.5708 + 0.3 * (fract(h * 5.7) - 0.5);
  c.radii = vec2(0.2, 0.7);
  return c;
}

Cell cellAt(vec2 s, float h) {
  Cell c = Cell(NONE, vec2(0.68, 0.62) + 0.08 * vec2(fract(h * 7.3), fract(h * 3.1)), 6.2831 * fract(h * 13.7), false);
  // Off the section, nothing: the backdrop's own outline, frayed.
  vec2 n = (s * PAGE_PER_CELL - uView * 0.5) / uScale;
  float edge = (n.x / 1.25) * (n.x / 1.25) + (n.y / 0.88) * (n.y / 0.88) - 1.0 - 0.12 * sin(5.0 * atan(n.y, n.x));
  if (edge + 0.06 * (noise(s / 6.0) - 0.5) > 0.0) return c;
  // Turning to the next tissue, each cell goes over at its own moment.
  int tissue = fract(h * 91.7) < uTurn ? uNext : uTissue;
  vec2 w = s + 24.0 * (vec2(fbm(s / 60.0), fbm(s / 60.0 + 17.3)) - 0.5);
  if (tissue == LYMPH_NODE) return lymphNode(c, w, h);
  if (tissue == COLON) return colon(c, w, h);
  if (tissue == CORTEX) return cortex(c, w, h);
  if (tissue == TUMOUR) return tumour(c, w, h);
  return pancreas(c, w, h);
}

void main() {
  float r = length(vLocal);
  float disc = 1.0 - smoothstep(uLensR - 1.0, uLensR + 0.5, r);
  vec4 tissue = vec4(0);
  if (disc > 0.0 && uLens.z > 0.0) {
    // A gentle barrel: the glass magnifies most at its centre. Coming into focus, the
    // view also settles from a little wider.
    float focus = 1.0 - pow(1.0 - uFocus, 3.0);
    float t = r / uLensR;
    vec2 x = uLens.xy / PAGE_PER_CELL + vLocal / CELL_PX * (1.0 + 0.3 * t * t) * mix(1.25, 1.0, focus);

    // The nearest cell, then the distance to its border, corners rounded.
    vec2 cell = floor(x);
    vec2 f = fract(x);
    vec2 mg = vec2(0);
    vec2 mr = vec2(0);
    float md = 8.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(i, j);
      vec2 rr = g + site(cell + g) - f;
      float d = dot(rr, rr);
      if (d < md) { md = d; mr = rr; mg = g; }
    }
    float b = 8.0;
    for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
      vec2 g = mg + vec2(i, j);
      vec2 rr = g + site(cell + g) - f;
      if (dot(mr - rr, mr - rr) > 1e-5) b = smin(b, dot(0.5 * (mr + rr), normalize(rr - mr)), 0.2);
    }
    vec2 id = cell + mg;
    float h = hash12(id + 3.7);
    Cell c = cellAt(x + mr, h);

    vec3 rgb = uBg;
    if (c.hue != NONE) {
      // Trimmed to its ellipse.
      vec2 q = -mr;
      float cs = cos(c.heading);
      float sn = sin(c.heading);
      q = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
      float e = (length(q / c.radii.yx) - 1.0) * min(c.radii.x, c.radii.y);
      float s = min(b - GAP, -e);
      // Lobules: acinar cells stop short of the septa between them, where there are septa.
      if (c.lobular && noise(x / 30.0 + 50.0) > 0.4) {
        vec2 xl = x + 8.0 * (vec2(noise(x / 12.0), noise(x / 12.0 + 4.0)) - 0.5);
        s = min(s, border(xl / 24.0) * 24.0 - 0.26);
      }
      float px = length(fwidth(x)) * 0.7071;
      float aa = px * (1.0 + 5.0 * (1.0 - focus));
      float lw = LINE_PX * uDpr * px;
      float line = 1.0 - smoothstep(-aa, aa, abs(s - lw * 0.5) - lw * 0.5);
      float fill = smoothstep(-aa, aa, s);
      vec3 col = uHues[c.hue];
      // Quieter behind the words.
      float hush = 1.0 - smoothstep(0.34, 1.0, length((uLens.xy + vLocal - uHush.xy) / uHush.zw));
      float ink = (c.hue == SLATE ? 0.7 : 0.95) * (1.0 - 0.35 * hush);
      rgb = mix(rgb, col, fill * 0.035);
      rgb = mix(rgb, col, line * ink);
    }
    tissue = vec4(rgb, 1.0) * disc * uLens.z;
  }

  float rim = exp(-pow((r - uLensR) / 1.1, 2.0)) * 0.7;
  float glow = exp(-pow((r - uLensR) / 10.0, 2.0)) * 0.16;
  float warm = exp(-pow((r - uLensR - 2.2) / 1.3, 2.0)) * 0.3;
  float cool = exp(-pow((r - uLensR + 2.2) / 1.3, 2.0)) * 0.3;
  float sheen = smoothstep(uLensR, uLensR * 0.5, r) * smoothstep(0.3, 1.0, dot(vLocal / max(r, 1e-3), vec2(-0.6, -0.8))) * 0.07;
  vec3 glass = uAccent * (rim + glow) + vec3(0.95, 0.3, 0.45) * warm + vec3(0.3, 0.5, 1.0) * cool + vec3(sheen);
  float a = clamp(rim + glow + warm + cool + sheen, 0.0, 1.0) * uLens.z;
  outColor = vec4(glass * uLens.z, a) + tissue * (1.0 - a);
}`;

function compile(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'program');
  return program;
}

const hexRgb = (hex: string) => {
  const v = parseInt(hex.trim().replace('#', ''), 16);
  return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

// The landing page's colors, from Cirro's own: its teal and navy, the plum and green of
// its theme, a rose and a violet in the same cool family, and its slate; on the dark page
// the same hues lifted to read on navy, with the pale highlight in place of navy.
const PALETTE: Record<'light' | 'dark', Record<(typeof HUES)[number], string>> = {
  light: { teal: '#0e7ca0', plum: '#7d2d65', green: '#2e7d55', navy: '#050b26', rose: '#c4669c', violet: '#5b4bb7', slate: '#9a9bab' },
  dark: { teal: '#1a9ab5', plum: '#c25a9e', green: '#4fb889', navy: '#b6d8e2', rose: '#f0a3c8', violet: '#9d8cf0', slate: '#7d86a3' },
};
// Stained tissue outside the lens: hematoxylin and eosin in Cirro's violet and rose on a
// light page; a nuclear stain in its teal and cyan on a dark one.
const STAINS = { light: ['#5f5aa2', '#d98fb8'], dark: ['#1a9ab5', '#5cd3e4'] };

export default function Backdrop() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false });
    if (!gl) return;
    let cells: WebGLProgram;
    let lens: WebGLProgram;
    try {
      cells = compile(gl, CELL_VERTEX, CELL_FRAGMENT);
      lens = compile(gl, LENS_VERTEX, LENS_FRAGMENT);
    } catch {
      // A decoration: a GPU that can't build it leaves the plain page.
      return;
    }
    const at = (program: WebGLProgram, name: string) => gl.getUniformLocation(program, name);

    const cellVao = gl.createVertexArray();
    gl.bindVertexArray(cellVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, makeCells(), gl.STATIC_DRAW);
    for (const [name, size, offset] of [['aTissue', 2, 0], ['aSeed', 1, 8]] as const) {
      const loc = gl.getAttribLocation(cells, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 12, offset);
    }
    const lensVao = gl.createVertexArray();
    gl.bindVertexArray(lensVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(lens, 'aCorner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);

    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    let additive = false;
    const theme = () => {
      const style = getComputedStyle(document.documentElement);
      const token = (name: string) => hexRgb(style.getPropertyValue(name) || '#888888');
      additive = document.documentElement.dataset.theme === 'dark' || (dark.matches && document.documentElement.dataset.theme !== 'light');
      gl.useProgram(cells);
      gl.uniform3fv(at(cells, 'uStain'), STAINS[additive ? 'dark' : 'light'].flatMap(hexRgb));
      gl.useProgram(lens);
      gl.uniform3fv(at(lens, 'uAccent'), token('--sds-color-accent'));
      gl.uniform3fv(at(lens, 'uBg'), token('--sds-color-bg'));
      gl.uniform3fv(at(lens, 'uHues'), HUES.flatMap((hue) => hexRgb(PALETTE[additive ? 'dark' : 'light'][hue])));
    };
    theme();

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const pointer = { x: -1e4, y: -1e4, at: -Infinity };
    const lensAt = { x: -1e4, y: -1e4, shown: 0 };
    const wake = new Float32Array(WAKE * 3);
    let wakeNext = 0;
    let wakeFrom = { x: -1e4, y: -1e4 };
    const pulse = new Float32Array([0, 0, 0, 0]);
    let focusFrom = -Infinity;
    // The tissue the section shows and when it began showing. Each time the lens appears
    // it shows the next tissue (after the first), and a long look turns over to the next
    // every TISSUE_MS, counted only while the lens is up.
    let tissue = 0;
    let tissueFrom = 0;
    let lensUp = false;
    let looks = 0;
    const nextTissue = (at: number) => {
      tissue = (tissue + 1) % TISSUES;
      tissueFrom = at;
    };
    let frame = 0;
    let last = performance.now();
    const start = last;

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
      if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // The lens catches up with the pointer, shows while it moves and fades once it rests.
      const follow = still ? 1 : 1 - Math.exp(-dt * FOLLOW);
      lensAt.x += (pointer.x - lensAt.x) * follow;
      lensAt.y += (pointer.y - lensAt.y) * follow;
      const wanted = now - pointer.at < IDLE_MS ? 1 : 0;
      // A lens that was gone comes into focus afresh, on the next tissue.
      if (wanted && !lensUp) {
        lensUp = true;
        focusFrom = now;
        if (looks++) nextTissue(now);
        else tissueFrom = now;
      }
      if (!wanted && lensAt.shown < 0.02) lensUp = false;
      if (!still && lensUp && now - tissueFrom >= TISSUE_MS + TURN_MS) nextTissue(now);
      lensAt.shown = still ? wanted : lensAt.shown + (wanted - lensAt.shown) * (1 - Math.exp(-dt * 4));
      if (!still) {
        const moved = Math.hypot(lensAt.x - wakeFrom.x, lensAt.y - wakeFrom.y);
        for (let i = 0; i < WAKE; i++) wake[i * 3 + 2] *= Math.exp(-dt / WAKE_FADE);
        if (moved > 6 && moved < 400) {
          wake.set([lensAt.x, lensAt.y, Math.min(1, moved / dt / 900) * lensAt.shown], wakeNext * 3);
          wakeNext = (wakeNext + 1) % WAKE;
        }
        if (moved > 6) wakeFrom = { x: lensAt.x, y: lensAt.y };
        if (pulse[3]) {
          pulse[2] += dt;
          if (pulse[2] > PULSE_S) pulse[3] = 0;
        }
      }

      const lensR = Math.max(80, Math.min(150, Math.min(w, h) * 0.16));

      gl.blendFunc(gl.ONE, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(cells);
      gl.uniform2f(at(cells, 'uView'), w, h);
      const scale = Math.min(w / 3.0, h / 2.1);
      const seconds = still ? 0 : (now - start) / 1000;
      // The words sit in the middle: an ellipse 44% by 36% of the page, a little high.
      const hush = [w / 2, h * 0.48, w * 0.44, h * 0.36] as const;
      gl.uniform1f(at(cells, 'uScale'), scale);
      gl.uniform1f(at(cells, 'uTime'), seconds);
      gl.uniform3fv(at(cells, 'uWake'), wake);
      gl.uniform4fv(at(cells, 'uPulse'), pulse);
      gl.uniform4f(at(cells, 'uHush'), ...hush);
      gl.uniform1f(at(cells, 'uPx'), CELL_PX * dpr);
      gl.bindVertexArray(cellVao);
      gl.drawArrays(gl.POINTS, 0, N);

      if (lensAt.shown > 0.01) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(lens);
        gl.uniform2f(at(lens, 'uView'), w, h);
        gl.uniform3f(at(lens, 'uLens'), lensAt.x, lensAt.y, lensAt.shown);
        gl.uniform1f(at(lens, 'uLensR'), lensR);
        gl.uniform1f(at(lens, 'uScale'), scale);
        gl.uniform1f(at(lens, 'uTime'), seconds);
        gl.uniform1i(at(lens, 'uTissue'), tissue);
        gl.uniform1i(at(lens, 'uNext'), (tissue + 1) % TISSUES);
        gl.uniform1f(at(lens, 'uTurn'), still ? 0 : Math.max(0, (now - tissueFrom - TISSUE_MS) / TURN_MS));
        gl.uniform1f(at(lens, 'uFocus'), still ? 1 : Math.min(1, (now - focusFrom) / FOCUS_MS));
        gl.uniform1f(at(lens, 'uDpr'), dpr);
        gl.uniform4f(at(lens, 'uHush'), ...hush);
        gl.bindVertexArray(lensVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      if (!still) frame = requestAnimationFrame(draw);
    };

    const onMove = (e: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      pointer.x = e.clientX - box.left;
      pointer.y = e.clientY - box.top;
      // Arriving, the lens starts where the pointer is rather than gliding in from afar.
      if (lensAt.shown < 0.01) Object.assign(lensAt, { x: pointer.x, y: pointer.y });
      pointer.at = performance.now();
      if (still) draw(pointer.at);
    };
    const onLeave = () => {
      pointer.at = -Infinity;
      if (still) draw(performance.now());
    };
    const onDown = (e: PointerEvent) => {
      if (still) return;
      const box = canvas.getBoundingClientRect();
      pulse.set([e.clientX - box.left, e.clientY - box.top, 0, 1]);
    };
    const onResize = () => draw(performance.now());
    const onScheme = () => {
      theme();
      if (still) draw(performance.now());
    };
    dark.addEventListener('change', onScheme);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onDown);
    document.documentElement.addEventListener('pointerleave', onLeave);
    if (still) window.addEventListener('resize', onResize);
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', onResize);
      dark.removeEventListener('change', onScheme);
    };
  }, []);
  return <canvas ref={ref} className="start-backdrop" aria-hidden="true" />;
}
