interface Props {
  regionCount: number;
  drawRingLength: number;
  drawPolygonsLength: number;
  onFinish: () => void;
  onClear: () => void;
}

// "Finish region / Clear" controls shared by the annotations and subsetting
// panels — drawing happens on the canvas, these actions just manage the ring.
export default function DrawControls({ regionCount, drawRingLength, drawPolygonsLength, onFinish, onClear }: Props) {
  return (
    <>
      <p className="text-[10px] text-muted leading-snug">
        {regionCount} region{regionCount === 1 ? '' : 's'}
        {drawRingLength > 0 ? `, ${drawRingLength}-pt drawing` : ''}.
      </p>
      <div className="flex gap-1">
        <button
          type="button"
          onClick={onFinish}
          disabled={drawRingLength < 3}
          className="flex-1 py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent disabled:opacity-40 transition-colors"
        >
          Finish region
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={drawPolygonsLength === 0 && drawRingLength === 0}
          className="flex-1 py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent disabled:opacity-40 transition-colors"
        >
          Clear
        </button>
      </div>
    </>
  );
}
