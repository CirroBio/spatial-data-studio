// Stable `data-tour` values — the targeting contract between the UI and tours.
// Renaming or removing one is a breaking change: `npm run check:tours` fails if
// a value here has no matching `data-tour="..."` attribute in the source.
export const TourAnchors = {
  SessionPicker: 'session-picker',
  NewSession: 'new-session',
  SaveSession: 'save-session',
  Snapshots: 'snapshots',
  ViewSwitcher: 'view-switcher',
  SidebarTabs: 'sidebar-tabs',
  AddFunction: 'add-function',
  BrowseRecipes: 'browse-recipes',
} as const;

export type TourAnchor = (typeof TourAnchors)[keyof typeof TourAnchors];
