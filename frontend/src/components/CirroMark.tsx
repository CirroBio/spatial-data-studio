import { useId } from 'react';

// The Cirro brand mark, traced from the Cirro logo artwork (public/favicon.svg holds the
// same geometry for the browser tab). Normalized so the ring's outer radius is 100 and
// its centre is the origin.
//
// Static form: a full ring with a blank channel carved through it by the link glyph.
// Spinning form: the ring becomes an open arc so the rotation reads, and the two parts
// counter-rotate at different periods — the loader from @cirrobio/ui.
const RING_MID_R = 79; // centreline radius; outer edge 100, inner edge 58
const RING_WIDTH = 42;

// Two nodes of radius 40.57, centres 131.31 apart on an axis 30.1 degrees above
// horizontal, joined by a waist that narrows to 5.73 (arcs of radius 38.71).
const LINK_PATH =
  'M 17.66 -36.53 A 38.71 38.71 0 0 0 73.12 -68.69 A 40.57 40.57 0 1 1 95.94 -29.34 ' +
  'A 38.71 38.71 0 0 0 40.47 2.82 A 40.57 40.57 0 1 1 17.66 -36.53 Z';

// Half-width of the blank channel the link carves through the ring. At this offset the
// lower node's keep-out lands exactly on the ring's inner edge, as in the artwork.
const CHANNEL_HALF_WIDTH = 17.4;

// 226.7 degrees of arc, matching the loader artwork — a near-closed ring reads as static
// however fast it turns.
const SPIN_ARC_PATH =
  `M -56.54 55.17 A ${RING_MID_R} ${RING_MID_R} 0 0 0 73.07 30.04` +
  ` A ${RING_MID_R} ${RING_MID_R} 0 0 0 -1.38 -78.99`;

const RING_COLOR = '#0e7ca0'; // COLOR_SECONDARY in @cirrobio/ui
const LINK_COLOR = '#24bfd3'; // COLOR_LOGO_LIGHT in @cirrobio/ui

// Tight around the static mark.
const STATIC_VIEW_BOX = '-101 -108 256 209';

// The spinning form needs room for the link to sweep a full turn (its far node reaches
// 172 from the centre). Its view box starts at 0 0 rather than being centred on the
// origin because `transform-origin: center` resolves against a reference box anchored at
// the user-space origin, not at the view box's min-x/min-y — so with a negative min the
// rotation would pivot off the mark. Hence: square box from 0, and a static translate
// that moves the origin-centred geometry to its centre.
const SPIN_EXTENT = 352;
const SPIN_CENTRE = SPIN_EXTENT / 2;

export default function CirroMark({
  className,
  spinning = false,
}: {
  className?: string;
  spinning?: boolean;
}) {
  // Mask ids are document-global, so each instance needs its own. useId's value contains
  // colons, which aren't valid in the `url(#…)` reference below — strip them.
  const maskId = `cirro-channel-${useId().replace(/:/g, '')}`;

  if (spinning) {
    // Decorative — every caller pairs it with its own progress text.
    return (
      <svg
        viewBox={`0 0 ${SPIN_EXTENT} ${SPIN_EXTENT}`}
        className={className}
        aria-hidden="true"
      >
        <g className="cirro-spin-ring">
          <g transform={`translate(${SPIN_CENTRE} ${SPIN_CENTRE})`}>
            <path
              d={SPIN_ARC_PATH}
              fill="none"
              stroke={RING_COLOR}
              strokeWidth={RING_WIDTH}
              strokeLinecap="round"
            />
          </g>
        </g>
        <g className="cirro-spin-link">
          <g transform={`translate(${SPIN_CENTRE} ${SPIN_CENTRE})`}>
            <path d={LINK_PATH} fill={LINK_COLOR} />
          </g>
        </g>
      </svg>
    );
  }

  return (
    <svg viewBox={STATIC_VIEW_BOX} className={className} role="img" aria-label="Cirro">
      <mask id={maskId} maskUnits="userSpaceOnUse" x={-176} y={-176} width={352} height={352}>
        <rect x={-176} y={-176} width={352} height={352} fill="#fff" />
        <path d={LINK_PATH} fill="#000" stroke="#000" strokeWidth={CHANNEL_HALF_WIDTH * 2} />
      </mask>
      <circle
        r={RING_MID_R}
        fill="none"
        stroke={RING_COLOR}
        strokeWidth={RING_WIDTH}
        mask={`url(#${maskId})`}
      />
      <path d={LINK_PATH} fill={LINK_COLOR} />
    </svg>
  );
}
