import { useCallback, useEffect, useRef } from 'react';
import { OVERLAY_PANEL } from './overlayStyles';
import type { ScatterPositions } from './useArrowPositions';

// Overview inset ("minimap") — a thumbnail of the whole section with a white box
// marking the part of it the main canvas is showing, so a zoomed-in view keeps its
// context. Click or drag inside it to move the main view there.
//
// It works in the canvas' own coordinate space (image level-0 pixels when the display
// has an image, else world/spot units), which is what `extent` and `viewport` carry.

// Longest side of the inset in CSS pixels.
const MINIMAP_MAX_PX = 160;
// Cells drawn in the scatter overview (no image, or the image hidden); beyond this
// the points are strided — the overview only needs the shape of the section.
const MAX_OVERVIEW_POINTS = 4000;

interface Props {
  // Whole-image overview to show; null draws the cell scatter instead.
  imageUrl: string | null;
  positions: ScatterPositions | null;
  colors: Uint8Array | null;
  // World -> canvas-space affine [a,b,c,d,e,f] for the scatter overview, or null when
  // the canvas is already in world space (no image).
  worldToCanvas: [number, number, number, number, number, number] | null;
  // [x0,y0,x1,y1] of the whole section, in canvas coordinate space.
  extent: [number, number, number, number];
  viewport: { target: [number, number]; zoom: number };
  canvasSize: { width: number; height: number };
  invertX: boolean;
  invertY: boolean;
  onNavigate: (target: [number, number]) => void;
  onNavigateEnd: () => void;
}

export default function Minimap({
  imageUrl, positions, colors, worldToCanvas, extent, viewport, canvasSize,
  invertX, invertY, onNavigate, onNavigateEnd,
}: Props) {
  const [ex0, ey0, ex1, ey1] = extent;
  const ew = Math.max(ex1 - ex0, 1e-9);
  const eh = Math.max(ey1 - ey0, 1e-9);
  const scale = MINIMAP_MAX_PX / Math.max(ew, eh);
  const width = Math.max(24, Math.round(ew * scale));
  const height = Math.max(24, Math.round(eh * scale));

  // Canvas space -> inset CSS pixels. The view is y-up (FlipOrthographicView leaves
  // deck's flipY off unless invert_y is set), so a content y maps to a CSS y measured
  // from the bottom; invert_x/invert_y mirror the main view and the inset with it.
  const toCss = useCallback((x: number, y: number): [number, number] => {
    const u = (x - ex0) / ew;
    const v = (y - ey0) / eh;
    return [(invertX ? 1 - u : u) * width, (invertY ? v : 1 - v) * height];
  }, [ex0, ey0, ew, eh, width, height, invertX, invertY]);

  const fromCss = useCallback((px: number, py: number): [number, number] => {
    const u = invertX ? 1 - px / width : px / width;
    const v = invertY ? py / height : 1 - py / height;
    return [ex0 + u * ew, ey0 + v * eh];
  }, [ex0, ey0, ew, eh, width, height, invertX, invertY]);

  // The main canvas' window in canvas units: deck's OrthographicView puts 2**zoom
  // pixels per unit, so the visible span is canvasSize / 2**zoom centered on target.
  const halfW = (canvasSize.width / 2) / Math.pow(2, viewport.zoom);
  const halfH = (canvasSize.height / 2) / Math.pow(2, viewport.zoom);
  const [ax, ay] = toCss(viewport.target[0] - halfW, viewport.target[1] - halfH);
  const [bx, by] = toCss(viewport.target[0] + halfW, viewport.target[1] + halfH);
  const box = {
    left: Math.min(ax, bx), top: Math.min(ay, by),
    width: Math.abs(bx - ax), height: Math.abs(by - ay),
  };

  // Cell-scatter overview (no image / image hidden), drawn once per data or layout
  // change onto a backing canvas at device resolution.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || imageUrl || !positions) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(width * dpr);
    el.height = Math.round(height * dpr);
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const stride = Math.max(1, Math.ceil(positions.numRows / MAX_OVERVIEW_POINTS));
    const m = worldToCanvas;
    for (let i = 0; i < positions.numRows; i += stride) {
      const wxp = positions.positions[i * 2];
      const wyp = positions.positions[i * 2 + 1];
      const x = m ? m[0] * wxp + m[1] * wyp + m[2] : wxp;
      const y = m ? m[3] * wxp + m[4] * wyp + m[5] : wyp;
      const [cx, cy] = toCss(x, y);
      ctx.fillStyle = colors
        ? `rgba(${colors[i * 4]},${colors[i * 4 + 1]},${colors[i * 4 + 2]},${colors[i * 4 + 3] / 255})`
        : 'rgba(160,160,160,0.9)';
      ctx.fillRect(cx - 0.5, cy - 0.5, 1.5, 1.5);
    }
  }, [imageUrl, positions, colors, worldToCanvas, width, height, toCss]);

  const dragging = useRef(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const navigateFrom = useCallback((clientX: number, clientY: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = Math.min(Math.max(clientX - rect.left, 0), width);
    const py = Math.min(Math.max(clientY - rect.top, 0), height);
    onNavigate(fromCss(px, py));
  }, [fromCss, width, height, onNavigate]);

  // Positioned below the Spatial/Embeddings/Tables switch, which owns the same corner.
  return (
    <div
      ref={boxRef}
      style={{
        ...OVERLAY_PANEL,
        width, height,
        top: 44, left: 8, zIndex: 20,
        borderRadius: 4,
        overflow: 'hidden',
        cursor: 'crosshair',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
      title="Overview — click or drag to move the view"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
        navigateFrom(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => { if (dragging.current) navigateFrom(e.clientX, e.clientY); }}
      onPointerUp={() => { if (dragging.current) { dragging.current = false; onNavigateEnd(); } }}
      onPointerCancel={() => { dragging.current = false; }}
    >
      {/* The thumbnail's first row is the image's y=0, which the y-up view puts at the
          bottom — so it is flipped vertically to match the canvas, and mirrored again
          for each axis the user inverted. */}
      {imageUrl ? (
        <img
          src={imageUrl}
          alt="section overview"
          draggable={false}
          style={{
            width: '100%', height: '100%', objectFit: 'fill',
            transform: `scale(${invertX ? -1 : 1}, ${invertY ? 1 : -1})`,
          }}
        />
      ) : (
        <canvas ref={canvasRef} style={{ width, height }} />
      )}
      <div
        style={{
          position: 'absolute',
          border: '1px solid rgb(255 255 255 / 0.9)',
          background: 'rgb(255 255 255 / 0.1)',
          pointerEvents: 'none',
          left: box.left, top: box.top, width: box.width, height: box.height,
        }}
      />
    </div>
  );
}
