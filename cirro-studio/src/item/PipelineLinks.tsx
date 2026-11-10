// Pipelines that take a dataset further, each opening Cirro's own launch form for it:
// the forms are long and Cirro shows cost and permissions, so the app hands over there.
import { useEffect, useState } from 'react';
import { useStudio } from '../app/studio';
import { describeError } from '../cirro/session';
import type { PipelineLink, PipelinePurpose } from '../data/collection';

type ItemPurpose = Extract<PipelinePurpose, 'segment' | 'encode'>;

// What a read-only project shows in place of the pipelines it can't run.
const ACTION: Record<ItemPurpose, string> = { segment: 'Run cell segmentation', encode: 'Make spatial data' };

export function PipelineLinks({ datasetId, purpose, about }: { datasetId: string; purpose: ItemPurpose; about: string }) {
  const { collection, session } = useStudio();
  const [links, setLinks] = useState<PipelineLink[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (collection.access === 'read') return;
    let live = true;
    collection.pipelines(datasetId, purpose).then((l) => live && setLinks(l), (e: unknown) => live && setProblem(describeError(e)));
    return () => {
      live = false;
    };
  }, [collection, datasetId, purpose]);
  // Running a pipeline adds a dataset to the project, so a project you can only read shows
  // what could run, switched off, with what would let you run it. Logging in doesn't open
  // a public project to writing, so the reason names your own projects.
  if (collection.access === 'read') {
    return (
      <div className="pipeline-links">
        <p className="muted task-about">{about}</p>
        <button type="button" className="task-button" disabled>
          <span className="task-label">{ACTION[purpose]}</span>
          <span className="task-about">
            {session ? 'Running it adds a dataset to this project, and you can only read it.' : 'Log in to Cirro to run it in your own projects.'}
          </span>
        </button>
      </div>
    );
  }
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
