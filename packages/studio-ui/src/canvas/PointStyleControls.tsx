import RangeField from './RangeField';

interface Props {
  pointSize: number;
  opacity: number;
  onChange: (patch: { point_size?: number; opacity?: number }) => void;
}

/* Point size + opacity sliders, used together by EmbeddingControls. The Spatial
   panel drives RangeField directly (size and opacity live in different sections). */
export default function PointStyleControls({ pointSize, opacity, onChange }: Props) {
  return (
    <>
      <RangeField label="Point size" value={pointSize} min={0.1} max={20} step={0.1}
        onChange={(v) => onChange({ point_size: v })} />
      <RangeField label="Opacity" value={opacity} min={0.1} max={1} step={0.05} digits={2}
        onChange={(v) => onChange({ opacity: v })} />
    </>
  );
}
