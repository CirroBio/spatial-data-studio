import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import SnapshotViewer from './components/SnapshotViewer';
import { fetchSnapshotConfig } from './lib/snapshots';
import { formatError } from './lib/errors';

// The schema major this bundle understands, baked in from snapshot-viewer.json at
// build time (see vite.app.config.ts `define`). A snapshot whose schema_version
// major differs was written for a different, immutable viewer bundle.
declare const __VIEWER_SCHEMA_MAJOR__: string;

// Mount contract (SNAPSHOT_CONTRACT §3, §7): a single generic HTML page carries
//   <div id="app" data-config="./<name>.sview.json"></div>
// and loads this classic <script>. We read data-config, resolve it against the
// page URL, fetch it, and render one snapshot. The config's `data` path is then
// resolved against the config URL inside SnapshotViewer (§4).
const MOUNT_ID = 'app';

function Message({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-bg text-muted text-sm px-6 text-center">
      {children}
    </div>
  );
}

function Viewer({ configUrl }: { configUrl: string }) {
  return (
    <div className="fixed inset-0 bg-bg text-text">
      <SnapshotViewer url={configUrl} />
    </div>
  );
}

async function main() {
  const mount = document.getElementById(MOUNT_ID);
  if (!mount) throw new Error(`Missing #${MOUNT_ID} mount element`);
  const root = createRoot(mount);

  const configAttr = mount.getAttribute('data-config');
  if (!configAttr) {
    root.render(<Message>Missing <code>data-config</code> on the #{MOUNT_ID} element.</Message>);
    return;
  }
  const configUrl = new URL(configAttr, document.baseURI).href;

  try {
    const cfg = await fetchSnapshotConfig(configUrl);
    const major = String(cfg.schema_version).split('.')[0];
    if (major !== __VIEWER_SCHEMA_MAJOR__) {
      root.render(
        <Message>
          This snapshot was saved for a different viewer version (schema {cfg.schema_version}); this
          viewer supports schema {__VIEWER_SCHEMA_MAJOR__}.x. Open the snapshot's own HTML page, which
          pins the matching viewer.
        </Message>,
      );
      return;
    }
    root.render(
      <StrictMode>
        <Viewer configUrl={configUrl} />
      </StrictMode>,
    );
  } catch (e) {
    root.render(<Message>Failed to load snapshot: {formatError(e)}</Message>);
  }
}

main();
