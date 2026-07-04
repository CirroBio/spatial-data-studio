import { useEffect, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { getPointsTransform, setPointsTransform } from '../api';
import { formatError, reportError } from '../lib/errors';
import { ModalOverlay, ModalHeader } from './DetailModal';

interface Props {
  sessionId: string;
  onClose: () => void;
}

const IDENTITY: number[] = [1, 0, 0, 0, 1, 0];

// Compose scale -> rotation -> translation into an affine [a, b, c, d, e, f].
function compose(sx: number, sy: number, rotDeg: number, tx: number, ty: number): number[] {
  const t = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return [cos * sx, -sin * sy, tx, sin * sx, cos * sy, ty];
}

const NUM = 'w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:border-accent';

export default function TransformEditor({ sessionId, onClose }: Props) {
  const setSavingJobId = useAppStore((s) => s.setSavingJobId);
  const [mode, setMode] = useState<'simple' | 'matrix'>('simple');
  const [matrix, setMatrix] = useState<number[]>(IDENTITY);
  const [element, setElement] = useState<string | null>(null);
  const [sx, setSx] = useState(1);
  const [sy, setSy] = useState(1);
  const [rot, setRot] = useState(0);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getPointsTransform(sessionId)
      .then(({ affine, element }) => {
        setElement(element);
        if (affine.length === 6) {
          setMatrix(affine);
          const isIdentity = affine.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);
          if (!isIdentity) setMode('matrix');
        }
      })
      .catch((err) => setError(formatError(err)));
  }, [sessionId]);

  const affine = mode === 'simple' ? compose(sx, sy, rot, tx, ty) : matrix;

  function setMatrixCell(i: number, v: number) {
    setMatrix((m) => m.map((cur, j) => (j === i ? v : cur)));
  }

  async function save() {
    setSaving(true);
    try {
      const { job_id } = await setPointsTransform(sessionId, affine);
      setSavingJobId(job_id);
      onClose();
    } catch (err) {
      reportError('Set transform failed', err);
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose} widthClassName="w-[420px]">
      <ModalHeader
        title="Points → global transform"
        subtitle={`Aligns the cells to the image${element ? ` (${element})` : ''}. Saved into the SpatialData object.`}
        onClose={onClose}
      />

      <div className="p-4 flex flex-col gap-3">
        <div className="flex gap-1 text-xs">
          {(['simple', 'matrix'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2.5 py-1 rounded border transition-colors ${
                mode === m ? 'border-accent text-accent bg-accent/10' : 'border-border text-muted hover:text-text'
              }`}
            >
              {m === 'simple' ? 'Scale / rotate / move' : 'Affine matrix'}
            </button>
          ))}
        </div>

        {mode === 'simple' ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[10px] text-muted uppercase tracking-wide">Scale X
              <input type="number" step="0.1" value={sx} onChange={(e) => setSx(Number(e.target.value))} className={NUM} />
            </label>
            <label className="flex flex-col gap-1 text-[10px] text-muted uppercase tracking-wide">Scale Y
              <input type="number" step="0.1" value={sy} onChange={(e) => setSy(Number(e.target.value))} className={NUM} />
            </label>
            <label className="flex flex-col gap-1 text-[10px] text-muted uppercase tracking-wide">Rotation°
              <input type="number" step="1" value={rot} onChange={(e) => setRot(Number(e.target.value))} className={NUM} />
            </label>
            <span />
            <label className="flex flex-col gap-1 text-[10px] text-muted uppercase tracking-wide">Translate X
              <input type="number" step="1" value={tx} onChange={(e) => setTx(Number(e.target.value))} className={NUM} />
            </label>
            <label className="flex flex-col gap-1 text-[10px] text-muted uppercase tracking-wide">Translate Y
              <input type="number" step="1" value={ty} onChange={(e) => setTy(Number(e.target.value))} className={NUM} />
            </label>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-[10px] text-muted">x' = a·x + b·y + c &nbsp;&nbsp; y' = d·x + e·y + f</p>
            <div className="grid grid-cols-3 gap-2">
              {['a', 'b', 'c', 'd', 'e', 'f'].map((lbl, i) => (
                <label key={lbl} className="flex flex-col gap-1 text-[10px] text-muted uppercase tracking-wide">{lbl}
                  <input
                    type="number"
                    step="0.1"
                    value={matrix[i]}
                    onChange={(e) => setMatrixCell(i, Number(e.target.value))}
                    className={NUM}
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        {error && <div className="text-xs text-danger">{error}</div>}

        <div className="flex items-center justify-between pt-1">
          <button
            onClick={() => {
              setSx(1); setSy(1); setRot(0); setTx(0); setTy(0); setMatrix(IDENTITY); setMode('simple');
            }}
            className="text-xs text-muted hover:text-text transition-colors"
          >
            Reset to identity
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-muted hover:text-text transition-colors">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="px-3 py-1.5 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white rounded text-xs transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  );
}
