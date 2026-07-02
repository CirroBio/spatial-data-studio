import FunctionForm from './forms/FunctionForm';
import type { FunctionEntry, SessionFields } from '../types';

interface Props {
  fn: FunctionEntry;
  fields: SessionFields;
  sessionId: string;
  submitting: boolean;
  params: Record<string, unknown>;
  note: string;
  onSubmit: (params: Record<string, unknown>) => void;
}

// The editing panel shared by the compute/plot detail views: a caption plus the
// original function form, pre-filled with the prior call's params.
export default function RerunEditor({ fn, fields, sessionId, submitting, params, note, onSubmit }: Props) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 py-2 text-xs text-muted border-b border-border shrink-0">{note}</div>
      <FunctionForm
        fn={fn}
        fields={fields}
        sessionId={sessionId}
        onSubmit={onSubmit}
        submitting={submitting}
        initialValues={params}
        submitLabel="Rerun"
      />
    </div>
  );
}
