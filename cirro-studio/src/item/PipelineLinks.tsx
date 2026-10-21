// Pipelines that take a dataset further, each opening Cirro's own launch form for it:
// the forms are long and Cirro shows cost and permissions, so the app hands over there.
import { useEffect, useState } from 'react';
import { useStudio } from '../app/studio';
import { describeError } from '../cirro/session';
import type { PipelineLink, PipelinePurpose } from '../data/collection';

export function PipelineLinks({ datasetId, purpose, about }: { datasetId: string; purpose: PipelinePurpose; about: string }) {
  const { collection } = useStudio();
  const [links, setLinks] = useState<PipelineLink[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    collection.pipelines(datasetId, purpose).then((l) => live && setLinks(l), (e: unknown) => live && setProblem(describeError(e)));
    return () => {
      live = false;
    };
  }, [collection, datasetId, purpose]);
  if (collection.kind === 'examples') return <p className="muted task-about">Log in to Cirro to run pipelines on your own data.</p>;
  return (
    <div className="pipeline-links">
      <p className="muted task-about">{about}</p>
      {problem && <p className="notice notice-warning">{problem}</p>}
      {links?.length === 0 && <p className="muted">No pipeline in this Cirro takes this kind of dataset for that.</p>}
      {links?.map((l) => (
        <a key={l.id} className="task-button" href={l.url} target="_blank" rel="noreferrer">
          <span className="task-label">{l.name}</span>
          <span className="task-about">Opens Cirro's form to run it on this dataset ↗</span>
        </a>
      ))}
    </div>
  );
}
