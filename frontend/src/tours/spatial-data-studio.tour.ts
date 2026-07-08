import { defineTour } from './schema';
import { TourAnchors } from './anchors';

// The intro tour. Session-dependent landmarks (view switcher, sidebar controls)
// are marked optional so the tour also works before a session is open.
export const spatialDataStudioTour = defineTour({
  id: 'sds-intro',
  version: 1,
  title: 'Welcome to Spatial Data Studio',
  trigger: 'first-visit',
  steps: [
    {
      id: 'welcome',
      target: { kind: 'center' },
      title: 'Welcome to Spatial Data Studio',
      body: 'A quick tour of the main tools for exploring and analyzing spatial data. Takes about 30 seconds.',
    },
    {
      id: 'session-picker',
      target: { kind: 'anchor', value: TourAnchors.SessionPicker },
      title: 'Sessions',
      body: 'Switch between open datasets here. A session holds a dataset plus the full history of what you have run on it.',
      placement: 'bottom',
    },
    {
      id: 'new-session',
      target: { kind: 'anchor', value: TourAnchors.NewSession },
      title: 'Start a new session',
      body: 'Load a spatial dataset into a fresh workspace.',
      placement: 'bottom',
    },
    {
      id: 'view-switcher',
      target: { kind: 'anchor', value: TourAnchors.ViewSwitcher },
      title: 'Switch views',
      body: 'Flip between the spatial canvas, embedding scatter plots, and the data-table inspector.',
      placement: 'right',
      optional: true,
    },
    {
      id: 'sidebar-tabs',
      target: { kind: 'anchor', value: TourAnchors.SidebarTabs },
      title: 'Compute, plots, annotations, subsetting',
      body: 'Each tab is a workflow: run analyses, build plots, draw labels on the canvas, or carve out a subset.',
      placement: 'right',
      optional: true,
    },
    {
      id: 'add-function',
      target: { kind: 'anchor', value: TourAnchors.AddFunction },
      title: 'Run an analysis',
      body: 'Pick a squidpy, scanpy, or custom function and run it on the current session. Every run is recorded in the history above.',
      placement: 'right',
      optional: true,
    },
    {
      id: 'browse-recipes',
      target: { kind: 'anchor', value: TourAnchors.BrowseRecipes },
      title: 'Recipes',
      body: 'Start from a bundled multi-step recipe, or export the steps you have run to share or replay.',
      placement: 'right',
      optional: true,
    },
    {
      id: 'save-session',
      target: { kind: 'anchor', value: TourAnchors.SaveSession },
      title: 'Save your work',
      body: 'Persist the session — its data and analysis history — so you can reopen it later. A dot appears here when there are unsaved changes.',
      placement: 'bottom',
    },
    {
      id: 'snapshots',
      target: { kind: 'anchor', value: TourAnchors.Snapshots },
      title: 'Snapshots',
      body: 'Browse point-in-time snapshots of your sessions. That is the tour — explore from here.',
      placement: 'bottom',
    },
  ],
});
