import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { setErrorSink } from '@cirrobio/spatial-viewer';
import { useAppStore } from './store/sessionStore';

// Route reportError into the app's notification store. Installed here rather than
// inside lib/errors so the canvas keeps no dependency on app state (see errors.ts).
setErrorSink((message) => useAppStore.getState().pushNotification({ kind: 'error', message }));

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
