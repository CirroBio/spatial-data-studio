import { defineTour } from './schema';
import { TourAnchors } from './anchors';

// The intro tour. Session-dependent landmarks (view switcher, display settings,
// sidebar controls) are marked optional so the tour also works before a session is
// open — which is when `first-visit` fires, so the empty-state step is optional for
// the mirror-image reason.
export const spatialDataStudioTour = defineTour({
  id: 'sds-intro',
  version: 3,
  title: 'Welcome to Spatial Data Studio',
  trigger: 'first-visit',
  steps: [
    {
      id: 'welcome',
      target: { kind: 'center' },
      title: 'Welcome to Spatial Data Studio',
      body: 'A quick tour of the main tools for exploring and analyzing spatial data. Takes about a minute.',
    },
    {
      id: 'new-session',
      target: { kind: 'anchor', value: TourAnchors.NewSession },
      title: 'Load a dataset',
      body: 'Start here. Point the app at a raw acquisition folder — Xenium, Visium, CosMx, MERSCOPE and more — or open an existing SpatialData .zarr store.',
      placement: 'bottom',
      optional: true,
    },
    {
      id: 'session-picker',
      target: { kind: 'anchor', value: TourAnchors.SessionPicker },
      title: 'Sessions',
      body: 'Switch between open datasets here. A session holds a dataset plus the full history of what you have run on it.',
      placement: 'bottom',
    },
    {
      id: 'session-lock',
      target: { kind: 'anchor', value: TourAnchors.SessionLock },
      title: 'Who can edit',
      body: 'Opening a session locks it to you, so a second person who connects can look but not change anything. The padlock says whether the session is locked to you, held by someone else, or free — click it to see who else is here, rename yourself, unlock it for a colleague, or take an unlocked one.',
      placement: 'bottom',
      optional: true,
    },
    {
      id: 'view-switcher',
      target: { kind: 'anchor', value: TourAnchors.ViewSwitcher },
      title: 'Switch views',
      body: 'Flip between the spatial canvas, embedding scatter plots, and the data-table inspector. A Plots view joins them once the session has drawn a figure.',
      placement: 'right',
      optional: true,
    },
    {
      id: 'display-settings',
      target: { kind: 'anchor', value: TourAnchors.DisplaySettings },
      title: 'Display settings',
      body: 'Color the cells by any gene or metadata column, choose which tissue-image channels are drawn and how, switch between points and cell-boundary outlines, and toggle the minimap — grouped into View, Cells and Image tabs. Minimize the panel and the gear icon brings it back.',
      placement: 'left',
      // No waitForMs: the panel lives in the canvas' `controls` slot, so it is absent
      // both while the canvas initializes (~2s) and forever on the views that have no
      // canvas — and a wait long enough for the former would stall every no-session
      // first visit on the latter. By the time a reader reaches this step the canvas
      // has long since mounted.
      optional: true,
    },
    {
      id: 'sidebar-tabs',
      target: { kind: 'anchor', value: TourAnchors.SidebarTabs },
      title: 'Compute, Plots, Regions, Annotations, Subset',
      body: 'Each tab is a workflow: run analyses, build plots, draw regions to label cells, mark up the canvas with shapes and text, or carve out a subset.',
      placement: 'right',
      optional: true,
    },
    {
      id: 'add-function',
      target: { kind: 'anchor', value: TourAnchors.AddFunction },
      title: 'Run an analysis',
      body: 'Pick an analysis function — from squidpy, scanpy, or the custom operations built into the app — and run it on the current session. Every run is recorded in the history above.',
      placement: 'right',
      optional: true,
    },
    {
      id: 'browse-recipes',
      target: { kind: 'anchor', value: TourAnchors.BrowseRecipes },
      title: 'Recipes',
      body: 'Run a bundled multi-step workflow — preprocess, cluster, annotate, neighborhood analysis — in one click, or stage its steps and edit them first. The buttons below load a recipe from a file and export the steps you have run.',
      placement: 'right',
      optional: true,
    },
    {
      id: 'menu',
      target: { kind: 'anchor', value: TourAnchors.Menu },
      title: 'App menu',
      body: 'Start a new session, save this one as a checkpoint you can reopen, export a snapshot figure of the current view or browse the gallery of saved ones, and upload to Cirro — plus theme, this tour, and citations. A dot marks unsaved changes or an upload in flight. That is the tour — explore from here.',
      placement: 'bottom',
    },
  ],
});
