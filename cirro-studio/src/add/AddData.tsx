// The Add Data page: how each stage's data reaches the project. Spatial data is too large
// to send through a web page, so it arrives one of two ways: uploaded from a terminal with
// Cirro's command-line tool, or made by a pipeline in Cirro from data already in the
// project. The page writes the upload command for this Cirro and project, and links each
// pipeline to Cirro's own form for it, where its input, options and cost are chosen.
import { useEffect, useRef, useState } from 'react';
import { stageOf } from '../app/library';
import { stepBack } from '../app/route';
import { useStudio } from '../app/studio';
import { STAGE_ICONS, tint } from '../app/ui';
import { describeError } from '../cirro/session';
import type { PipelineLink, UploadStage, UploadType } from '../data/collection';
import { hostOf } from '../tenants';
import { CLI_PYTHON, uploadCommand } from './uploadCommand';

interface Guide {
  stage: UploadStage;
  holds: string;
  // What to upload, and the folder the command starts with.
  upload: string;
  folder: string;
  // What the pipelines that make this stage's data do.
  make: string;
}

const GUIDES: Guide[] = [
  {
    stage: 'images',
    holds: 'Microscopy and histology images on their own, before any cells are found in them: H&E and other stains, immunofluorescence, multiplexed imaging.',
    upload: 'Upload a folder of images. OME-TIFF opens here; other slide formats are listed, and a pipeline below can convert them.',
    folder: './images',
    make: 'Convert a slide format a browser can\'t draw into OME-TIFF.',
  },
  {
    stage: 'runs',
    holds: 'An instrument\'s output as it wrote it: a Xenium, Visium, Visium HD, CosMx or MERSCOPE run, with its images and metrics.',
    upload: 'Upload the run\'s output folder whole, as the instrument or its software wrote it.',
    folder: './output',
    make: 'Count a Visium run\'s reads from its FASTQ files, find a Xenium run\'s cells again, or quantify multiplexed images with MCMICRO.',
  },
  {
    stage: 'spatial',
    holds: 'Analysis-ready SpatialData: a .zarr folder or a .zarr.zip, such as nf-core/sopa or spatialdata-io output, or a Spatial Data Studio checkpoint.',
    upload: 'Upload the folder that holds the store, not the store itself: the app looks for stores inside the dataset.',
    folder: './results',
    make: 'Make SpatialData from a run or an image already in the project: Spatial Data Studio\'s workflow reads a run as the instrument wrote it, and nf-core/sopa, Proseg and the segmentation pipelines find the cells.',
  },
];

export default function AddData() {
  const { session, collection } = useStudio();
  const back = () => stepBack({ section: 'home' });
  if (!session || collection.kind !== 'cirro') {
    return <div className="page-message"><p>Log in to Cirro to add data to one of your projects.</p></div>;
  }
  const figures = stageOf('figures');
  return (
    <div className="add-data">
      <header className="add-head">
        <button type="button" className="facts-back" onClick={back}>
          <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
          All data
        </button>
        <h1>Add data to {collection.name}</h1>
        <p className="muted">
          Spatial data is too large to send through a web page, so it reaches the project one of two ways: upload it from
          your computer with Cirro's command-line tool, or run a pipeline in Cirro on data already in the project. Either way it
          becomes a dataset in the project; reload the map once it has finished to see it there.
        </p>
      </header>
      {GUIDES.map((g) => <StageGuide key={g.stage} guide={g} host={hostOf(session.tenant)} projectId={collection.id} />)}
      <section className="add-stage" style={tint(figures.color)}>
        <h2><span className="add-icon">{STAGE_ICONS.figures}</span>{figures.label}</h2>
        <p className="muted">A figure is made here, not added: open a spatial dataset and keep a view with <strong>Save as a figure</strong>.</p>
      </section>
    </div>
  );
}

function StageGuide({ guide, host, projectId }: { guide: Guide; host: string; projectId: string }) {
  const stage = stageOf(guide.stage);
  return (
    <section className="add-stage" style={tint(stage.color)}>
      <h2><span className="add-icon">{STAGE_ICONS[guide.stage]}</span>{stage.label}</h2>
      <p className="muted">{guide.holds}</p>
      <div className="add-ways">
        <UploadWay guide={guide} host={host} projectId={projectId} />
        <PipelineWay guide={guide} />
      </div>
    </section>
  );
}

function UploadWay({ guide, host, projectId }: { guide: Guide; host: string; projectId: string }) {
  const { collection } = useStudio();
  const [types, setTypes] = useState<UploadType[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [typeId, setTypeId] = useState('');
  const [name, setName] = useState('');
  const [folder, setFolder] = useState(guide.folder);
  const [copied, setCopied] = useState<'yes' | 'refused' | null>(null);
  const commandRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let live = true;
    collection.uploadTypes(guide.stage).then((t) => {
      if (!live) return;
      setTypes(t);
      setTypeId(t[0]?.id ?? '');
    }, (e: unknown) => live && setProblem(describeError(e, 'list data types')));
    return () => {
      live = false;
    };
  }, [collection, guide.stage]);
  const type = types?.find((t) => t.id === typeId);
  const command = type ? uploadCommand({ host, projectId, dataTypeId: type.id, name: name || `My ${stageOf(guide.stage).unit[0]}`, folder: folder || '.' }) : null;
  const copy = () => {
    if (!command) return;
    // Where the browser refuses the clipboard, the command is selected for a keyboard copy.
    navigator.clipboard.writeText(command).then(() => setCopied('yes'), () => {
      if (commandRef.current) window.getSelection()?.selectAllChildren(commandRef.current);
      setCopied('refused');
    });
  };
  return (
    <div className="add-way">
      <h3>Upload from your computer</h3>
      <p className="muted">{guide.upload}</p>
      {problem && <p className="notice notice-warning">{problem}</p>}
      {types?.length === 0 && <p className="muted">This Cirro offers no data type to upload this as.</p>}
      {types && types.length > 0 && (
        <>
          <label className="field">
            <span>Data type</span>
            <select className="select" value={typeId} onChange={(e) => { setTypeId(e.target.value); setCopied(null); }}>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          {type?.requirements && <p className="muted add-note">{type.requirements}</p>}
          <div className="add-fields">
            <label className="field">
              <span>Dataset name</span>
              <input className="input" value={name} placeholder={`My ${stageOf(guide.stage).unit[0]}`} onChange={(e) => { setName(e.target.value); setCopied(null); }} />
            </label>
            <label className="field">
              <span>Folder on your computer</span>
              <input className="input mono" value={folder} onChange={(e) => { setFolder(e.target.value); setCopied(null); }} />
            </label>
          </div>
          <pre className="add-command"><code ref={commandRef}>{command}</code></pre>
          <div className="button-row">
            <button type="button" className="button button-small" onClick={copy}>{copied === 'yes' ? 'Copied' : 'Copy'}</button>
            {copied === 'refused' && <span className="muted">This browser won't copy for the page; the command is selected, so copy it from the keyboard.</span>}
          </div>
          <p className="muted add-note">
            Run it in a terminal, with {CLI_PYTHON}. Cirro checks the files against the data type before it uploads
            anything, and the first upload asks you to log in to Cirro in your browser.
          </p>
        </>
      )}
    </div>
  );
}

function PipelineWay({ guide }: { guide: Guide }) {
  const { collection } = useStudio();
  const [links, setLinks] = useState<PipelineLink[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    collection.pipelines(null, guide.stage).then((l) => live && setLinks(l), (e: unknown) => live && setProblem(describeError(e, 'list pipelines')));
    return () => {
      live = false;
    };
  }, [collection, guide.stage]);
  return (
    <div className="add-way">
      <h3>Run a pipeline in Cirro</h3>
      <p className="muted">{guide.make}</p>
      {problem && <p className="notice notice-warning">{problem}</p>}
      {links?.length === 0 && <p className="muted">No pipeline in this Cirro makes this kind of data.</p>}
      {links?.map((l) => (
        <a key={l.id} className="task-button" href={l.url} target="_blank" rel="noreferrer">
          <span className="task-label">{l.name}</span>
          <span className="task-about">{l.description || 'Opens Cirro\'s form to run it'} ↗</span>
        </a>
      ))}
    </div>
  );
}
