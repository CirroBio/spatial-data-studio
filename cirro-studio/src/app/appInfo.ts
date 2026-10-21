// APP_ID is written to Cirro as the `cirro-app` tag and never changes once used.
export const APP_ID = 'spatial-data-studio';
export const APP_NAME = 'Spatial Data Studio';
export const APP_VERSION: string = __APP_VERSION__;
export const REPO_URL = 'https://github.com/CirroBio/spatial-data-studio';
export const DOCS_URL = 'https://cirrobio.github.io/spatial-data-studio/';
export const CIRRO_URL = 'https://cirro.bio';
export const APP_TAG = { key: 'cirro-app', value: APP_ID };
// Sheets live in a namespace named after the app, `-` replaced by `_`.
export const SHEET_NAMESPACE = APP_ID.replace(/-/g, '_');
// App-specific URL parameters and browser keys carry the app's ID, so other Cirro apps
// can hand context over in the shared ones (tenant, project, dataset).
export const appKey = (name: string) => `${APP_ID}.${name}`;
