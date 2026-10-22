// APP_ID is written to Cirro as a tag on everything the app creates, and never changes
// once used.
export const APP_ID = 'spatial-data-studio';
export const APP_NAME = 'Spatial Data Studio';
export const APP_VERSION: string = __APP_VERSION__;
export const REPO_URL = 'https://github.com/CirroBio/spatial-data-studio';
// The docs are the About section of the site this app is the root of (docs.yml). Every
// page of the app keeps the root's path and routes by query, so a relative link reaches
// them from whatever domain serves the site.
export const DOCS_URL = 'about/';
export const CIRRO_URL = 'https://cirro.bio';
// A tag is a plain text label: Cirro deprecated its key, and its web app shows only the value.
export const APP_TAG = { value: APP_ID };
// Sheets live in a namespace named after the app, `-` replaced by `_`.
export const SHEET_NAMESPACE = APP_ID.replace(/-/g, '_');
// App-specific URL parameters and browser keys carry the app's ID, so other Cirro apps
// can hand context over in the shared ones (tenant, project, dataset).
export const appKey = (name: string) => `${APP_ID}.${name}`;
