// The extension every checkpoint carries, between the stem's content hash and the end
// of the name (backend: persistence/store.CHECKPOINT_EXT). Kept out of
// SaveCheckpointDialog so the upload dialog can filter on it without pulling that
// lazily loaded dialog into the main bundle.
export const CHECKPOINT_EXT = '.sdata.zarr.zip';
