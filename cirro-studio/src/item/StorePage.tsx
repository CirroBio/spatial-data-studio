// A spatial dataset opened: its version stack read in the browser and drawn across the
// page, laid out as the Studio lays out its own: the views as tabs over the canvas, the
// tasks in the drawer on the left, and the Studio's display settings docked in the
// drawer on the right. Tasks write into the draft; the bar at the bottom saves it as a
// version.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ColorBySelect } from '@cirrobio/studio-ui';
import type { CheckpointHandle, SessionFields } from '@cirrobio/spatial-viewer';
import type { SpatialEntity } from '../app/library';
import { refOfItem } from '../app/library';
import { LENS_PARAM, navigate, stepBack, TASK_PARAM, useRoute } from '../app/route';
import { useStudio } from '../app/studio';
import { formatCount, plural, SettingsIcon, tint } from '../app/ui';
import type { StoreItem, VersionItem } from '../data/model';
import { ChartFigure } from '../figures/ChartFigure';
import { coordinateUnit, storeReader } from '../figures/scaleBar';
import { readFigures, type FigureSpec } from '../figures/spec';
import { REPORT_LENS } from '../reports/parts';
import { ReportView } from '../reports/ReportView';
import { readResults, type KeptResult } from '../reports/store';
import { TaskList, TASKS } from '../tasks/TaskList';
import TaskPanel from '../tasks/TaskPanel';
import { storeOf, useWorkbench } from '../workbench/workbench';
import { Composition } from './Composition';
import { DraftBar } from './DraftBar';
import { Facts, kinOf } from './Facts';
import { History } from './History';
import { DatasetCanvases, EmbeddingLens, SpatialLens } from './LensCanvas';
import { showDisplay, updateEncoding, useDisplays } from './displayState';
import { useSelection } from './selection';
import { ViewTabs, type ViewDef } from './ViewTabs';
import { BAR_ROOM, useDrawers, ViewFrame } from './ViewFrame';

// An embedding's obsm key as people say it: X_umap_3d is "UMAP 3D".
const EMBEDDING_NAMES: Record<string, string> = { umap: 'UMAP', tsne: 't-SNE', pca: 'PCA', phate: 'PHATE', draw_graph_fa: 'ForceAtlas2' };
function embeddingName(key: string): string {
  const [, base, dims] = /^(.*?)(?:_(\d)d)?$/.exec(key.replace(/^X_/, ''))!;
  return `${EMBEDDING_NAMES[base] ?? base.replace(/_/g, ' ')}${dims ? ` ${dims}D` : ''}`;
}

// Readers whose observations are capture spots rather than segmented cells.
const SPOT_READERS = new Set(['visium']);

/** Cells (or spots) and genes, and whether the genes have values to analyse. */
function summary(fields: SessionFields, unit: string): string {
  if (!fields.n_obs) return 'An image, without cells';
  const genes = fields.var_names_count
    ? ` · ${formatCount(fields.var_names_count)} genes${fields.has_x ? '' : ' · no expression matrix'}`
    : '';
  return `${formatCount(fields.n_obs)} ${unit}s${genes}`;
}

export function StorePage({ item, entity }: { item: StoreItem | VersionItem; entity: SpatialEntity | null }) {
  const route = useRoute();
  const { collection, library, catalog } = useStudio();
  const top = useMemo(() => ({ datasetId: item.datasetId, path: item.path, kind: item.kind }), [item.datasetId, item.path, item.kind]);
  const wb = useWorkbench(collection, top);
  const displays = useDisplays(wb.key, wb.handle);
  const task = route.section === 'task' ? route.params.get(TASK_PARAM) : null;
  const taskDef = TASKS.find((t) => t.id === task) ?? null;
  const selecting = useSelection(wb.key).armed;
  const drawers = useDrawers(Boolean(taskDef));
  const overlayInset = useMemo(() => ({ ...drawers.inset, top: BAR_ROOM }), [drawers.inset]);
  // Where the canvas docks the Studio's settings panel (the Display drawer's body) and
  // its tools (the views bar).
  const [settings, setSettings] = useState<HTMLElement | null>(null);
  const [tools, setTools] = useState<HTMLElement | null>(null);
  const slots = useMemo(() => ({ settings, tools }), [settings, tools]);
  const [reader, setReader] = useState<string | null>(null);
  useEffect(() => {
    if (!wb.handle) return;
    let live = true;
    // A store that doesn't say keeps the defaults: cells, and no scale bar.
    storeReader(storeOf(wb.key)).then((r) => live && setReader(r), () => undefined);
    return () => {
      live = false;
    };
  }, [wb.key, wb.handle]);

  const [figures, setFigures] = useState<FigureSpec[]>([]);
  const [reports, setReports] = useState<KeptResult[]>([]);
  useEffect(() => {
    if (!wb.handle || !wb.handle.tableKey) return;
    let live = true;
    readFigures(storeOf(wb.key), wb.handle.tableKey).then((f) => live && setFigures(f), () => live && setFigures([]));
    readResults(storeOf(wb.key), wb.handle.tableKey).then((r) => live && setReports(r), () => live && setReports([]));
    return () => {
      live = false;
    };
  }, [wb.key, wb.handle, wb.revision]);

  const fields = wb.handle?.fields;
  const unit = reader && SPOT_READERS.has(reader) ? 'spot' : 'cell';
  const hasCells = Boolean(fields && fields.n_obs > 0);
  const embedding = displays.embedding;
  const saved = entity?.versions.length ?? 0;
  const views: ViewDef[] = [
    { id: 'tissue', label: 'Tissue' },
    ...(embedding ? [{ id: 'cells', label: `${unit === 'spot' ? 'Spot' : 'Cell'} map · ${embeddingName(embedding.encoding.obsm_key)}` }] : []),
    ...(hasCells ? [{ id: 'composition', label: 'Composition' }] : []),
    { id: 'versions', label: saved ? `Versions · ${saved}` : 'Versions' },
  ];
  const figureViews: ViewDef[] = figures.map((f) => ({ id: `figure:${f.id}`, label: f.title }));
  const reportViews: ViewDef[] = reports.map((r) => ({ id: `${REPORT_LENS}${r.id}`, label: r.meta.title }));
  const asked = route.params.get(LENS_PARAM);
  const lens = [...views, ...reportViews, ...figureViews].some((v) => v.id === asked) ? asked! : 'tissue';
  const figureOpen = figures.find((f) => `figure:${f.id}` === lens) ?? null;
  const reportOpen = reports.find((r) => `${REPORT_LENS}${r.id}` === lens) ?? null;
  // A canvas figure opens on its saved view however it is reached (its tab, the map, a
  // link, back or forward). Once per opening: the figures are re-read on every draft
  // edit, and while the figure is open its view is the user's to change.
  const figureShown = useRef<string | null>(null);
  useEffect(() => {
    const id = figureOpen?.id ?? null;
    if (id === figureShown.current) return;
    figureShown.current = id;
    if (figureOpen?.view.kind === 'canvas') showDisplay(wb.key, figureOpen.view.display);
  }, [wb.key, figureOpen]);
  // Choosing the open figure again returns it to its saved view.
  const chooseLens = (id: string) => {
    if (figureOpen?.view.kind === 'canvas' && id === `figure:${figureOpen.id}`) showDisplay(wb.key, figureOpen.view.display);
    navigate({ [LENS_PARAM]: id === 'tissue' ? null : id }, { replace: true });
  };
  // A figure lens shows its saved view; the canvas behind it is the one it was saved from.
  const canvasSlot = lens === 'cells' || (figureOpen?.view.kind === 'canvas' && figureOpen.view.display.type === 'embedding_canvas') ? 'embedding' : 'spatial';
  const colorBy = (canvasSlot === 'embedding' ? displays.embedding?.encoding.color_by : displays.spatial?.encoding.color_by) ?? null;
  const overrides = displays.spatial?.encoding.category_colors?.[colorBy ?? ''];
  const onCanvas = lens !== 'versions' && lens !== 'composition' && !reportOpen && figureOpen?.view.kind !== 'chart';
  // The tissue's own backdrop, which what sits on it follows.
  const backdrop = onCanvas && canvasSlot === 'spatial' ? displays.spatial?.encoding.background : undefined;

  const datasetName = catalog.byId.get(item.datasetId)?.name ?? item.label;
  const { from, into } = kinOf(entity?.base ?? item, library, (id) => catalog.byId.get(id)?.sourceIds ?? []);
  const title = item.kind === 'version' ? item.title : entity?.label ?? item.label;

  if (wb.status === 'error') {
    return (
      <div className="page-message">
        <p className="notice notice-danger">This dataset couldn't be opened: {wb.error}</p>
        <button type="button" className="button" onClick={() => stepBack({ section: 'home' })}>Back to the map</button>
      </div>
    );
  }

  let displayBody: ReactNode;
  if (onCanvas) {
    displayBody = <div className="display-settings studio-ui" ref={setSettings} />;
  } else if (lens === 'composition' && displays.spatial) {
    displayBody = (
      <div className="display-note studio-ui">
        <p className="muted">The composition counts the {unit}s in each group of what the tissue is colored by.</p>
        <ColorBySelect value={displays.spatial.encoding.color_by ?? ''} obsFields={fields!.obs} layers={fields!.layers}
          hasX={fields!.has_x} onChange={(path) => updateEncoding(wb.key, 'spatial', { color_by: path })} />
      </div>
    );
  } else {
    displayBody = <p className="muted display-note">Display settings apply to the tissue and the {unit} map.</p>;
  }

  // The version history, a chart figure and the composition are sheets; every other lens
  // draws on a canvas.
  const lensView = (handle: CheckpointHandle): ReactNode => {
    if (lens === 'versions' && entity) {
      return <div className="sheet"><History entity={entity} openRef={refOfItem(item)} draft={wb.changes} /></div>;
    }
    if (reportOpen) {
      return <div className="sheet sheet-report"><ReportView result={reportOpen} wb={wb} unit={unit} /></div>;
    }
    if (figureOpen?.view.kind === 'chart') {
      return <div className="sheet"><ChartFigure spec={figureOpen} store={storeOf(wb.key)} table={handle.tableKey} /></div>;
    }
    if (lens === 'composition' && displays.spatial) {
      return <div className="sheet sheet-fill"><Composition field={colorBy} version={wb.dataVersions[colorBy ?? ''] ?? 0} overrides={overrides} /></div>;
    }
    let canvas: ReactNode;
    if (canvasSlot === 'embedding' && displays.embedding) {
      canvas = <EmbeddingLens display={displays.embedding} wbKey={wb.key} handle={handle} selecting={selecting} slots={slots} />;
    } else if (displays.spatial) {
      canvas = <SpatialLens display={displays.spatial} wbKey={wb.key} selecting={selecting} slots={slots} unit={coordinateUnit(reader)} />;
    } else {
      canvas = <p className="view-empty muted">Nothing in this store can be drawn.</p>;
    }
    return <div className="view" data-backdrop={backdrop}>{canvas}</div>;
  };

  return (
    <div className="picture" style={tint('--sds-stage-store')}>
      <Facts title={title} item={item} kind={item.kind === 'version' ? `Version ${wb.levels.length - 1 || ''}`.trim() : 'Spatial data'}
        stage="spatial" from={from} into={into} unsaved={wb.changes.length > 0}
        extra={(
          <>
            {fields && <span className="facts-summary">{summary(fields, unit)}</span>}
            {saved > 0 && (
              <button type="button" className="kin-chip" onClick={() => chooseLens('versions')}>
                {plural(saved, ['version', 'versions'])} saved
              </button>
            )}
          </>
        )} />
      {!wb.handle ? (
        <div className="picture-loading">
          <span className="spinner" />
          <p className="muted">Opening {item.kind === 'version' ? 'the version and the store under it' : 'the store'}…</p>
        </div>
      ) : (
        <DatasetCanvases wbKey={wb.key} handle={wb.handle} dataVersions={wb.dataVersions} selecting={selecting} inset={overlayInset}>
          <ViewFrame drawers={drawers} sheet={!onCanvas}
            bar={(
              <div className="view-bar" data-backdrop={backdrop}>
                <ViewTabs views={views} reports={reportViews} figures={figureViews} current={lens} onChoose={chooseLens} />
                {onCanvas && <div ref={setTools} />}
              </div>
            )}
            left={{
              label: 'Tasks',
              content: taskDef ? (
                <TaskPanel task={taskDef} wb={wb} name={title} inset={drawers.inset} unit={unit} reports={reports} />
              ) : (
                <TaskList hasCells={hasCells} hasGenes={Boolean(fields?.has_x)} reports={reports} figures={figures} onFigure={(id) => chooseLens(`figure:${id}`)} />
              ),
            }}
            // Versions has nothing to set, so it takes the drawer's side of the page.
            right={lens === 'versions' ? undefined : {
              label: 'Display',
              icon: <SettingsIcon />,
              content: (
                <>
                  {figureOpen && <p className="caption-figure">{figureOpen.caption || figureOpen.title}</p>}
                  {displayBody}
                </>
              ),
            }}
            main={lensView(wb.handle)} />
        </DatasetCanvases>
      )}
      <DraftBar wb={wb} baseSize={entity?.base?.size ?? 0} datasetName={datasetName} />
    </div>
  );
}
