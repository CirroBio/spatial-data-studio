import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/sessionStore';
import { connectToCirro, getCirroAuth } from '../api';
import { formatError } from '@cirrobio/spatial-viewer';
import { ModalOverlay, ModalHeader } from './DetailModal';

// How often to re-check whether the user has finished logging in. Auth state is
// per-browser private (it carries the Cirro username), and the SSE bus is a
// broadcast to every connected client, so this is polled directly rather than
// pushed — a push would hand one user's identity to everyone else's browser.
const POLL_MS = 2000;

interface Props {
  onClose: () => void;
  /** Called once the login completes, so the caller can open the upload dialog. */
  onConnected?: () => void;
}

export default function CirroConnectDialog({ onClose, onConnected }: Props) {
  const { cirroAuth, setCirroAuth } = useAppStore();
  const [domain, setDomain] = useState(cirroAuth?.default_domain ?? 'app.cirro.bio');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const state = cirroAuth?.state ?? 'disconnected';
  const pending = state === 'pending';

  // While the device-code flow is open, poll until the user completes it in their
  // browser. The flow itself lives on the backend, so closing this dialog doesn't
  // abandon it — reopening picks the same pending login back up.
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const auth = await getCirroAuth();
        if (stopped) return;
        setCirroAuth(auth);
        if (auth.state === 'connected') onConnectedRef.current?.();
      } catch { /* transient; the next tick retries */ }
    }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [pending, setCirroAuth]);

  async function handleConnect() {
    setStarting(true);
    setError(null);
    try {
      setCirroAuth(await connectToCirro(domain.trim()));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setStarting(false);
    }
  }

  const fieldClass = 'w-full bg-bg border border-border rounded px-3 py-2 text-sm text-text placeholder-muted/50 focus:outline-none focus:border-accent';

  return (
    <ModalOverlay onClose={onClose} widthClassName="w-[520px] max-w-[94vw]">
      <ModalHeader
        title="Connect to Cirro"
        subtitle="Sign in with your own Cirro account to upload from this browser."
        onClose={onClose}
      />

      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
        {error && (
          <div className="text-xs text-danger bg-danger/10 border border-danger/20 rounded px-3 py-2">
            {error}
          </div>
        )}

        {state === 'failed' && cirroAuth?.error && (
          <div className="text-xs text-danger bg-danger/10 border border-danger/20 rounded px-3 py-2">
            Login failed: {cirroAuth.error}
          </div>
        )}

        {state === 'connected' ? (
          <div className="text-sm text-text">
            Connected to <span className="font-mono">{cirroAuth?.domain}</span>
            {cirroAuth?.username && <> as <span className="font-mono">{cirroAuth.username}</span></>}.
          </div>
        ) : pending ? (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-mono text-muted">Waiting for you to sign in…</span>
              <a
                href={cirroAuth?.login_url ?? '#'}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-accent underline break-all"
              >
                {cirroAuth?.login_url}
              </a>
              <span className="text-[10px] text-muted/60">
                Opens Cirro in a new tab. This dialog updates itself once you finish;
                closing it won't cancel the login.
              </span>
            </div>
            <div className="text-xs text-muted flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
              Authentication pending
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-mono text-muted" htmlFor="cirro-domain">
              Cirro domain <span className="text-danger">*</span>
            </label>
            <input
              id="cirro-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && domain.trim()) handleConnect(); }}
              autoComplete="off"
              spellCheck={false}
              className={`${fieldClass} font-mono`}
            />
            <span className="text-[10px] text-muted/60">
              For example <span className="font-mono">app.cirro.bio</span>. Everything
              else about your account is discovered from this.
            </span>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-4 py-3 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-muted hover:text-text border border-border rounded hover:bg-bg transition-colors"
        >
          {state === 'connected' ? 'Close' : 'Cancel'}
        </button>
        {state !== 'connected' && !pending && (
          <button
            onClick={handleConnect}
            disabled={!domain.trim() || starting}
            className="px-4 py-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-on-accent rounded text-sm transition-colors"
          >
            {starting ? 'Connecting…' : 'Continue'}
          </button>
        )}
      </div>
    </ModalOverlay>
  );
}
