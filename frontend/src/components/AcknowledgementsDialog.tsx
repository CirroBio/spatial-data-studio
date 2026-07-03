import { useEffect, useState } from 'react';
import { getThirdPartyLicenses, type ThirdPartyLicense } from '../api';
import { formatError } from '../lib/errors';

interface Props {
  onClose: () => void;
}

function LicenseTable({ title, entries }: { title: string; entries: ThirdPartyLicense[] }) {
  if (!entries.length) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold text-text mb-1">{title} ({entries.length})</h3>
      <div className="border border-border rounded-md divide-y divide-border">
        {entries.map((e) => (
          <div key={`${e.name}@${e.version}`} className="flex items-center justify-between gap-3 px-2.5 py-1 text-xs">
            <span className="font-mono text-text truncate">{e.name}</span>
            <span className="text-muted shrink-0">{e.version}</span>
            <span className="text-muted shrink-0 w-32 text-right truncate" title={e.license}>{e.license}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AcknowledgementsDialog({ onClose }: Props) {
  const [licenses, setLicenses] = useState<{ python: ThirdPartyLicense[]; npm: ThirdPartyLicense[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getThirdPartyLicenses()
      .then(setLicenses)
      .catch((err) => setError(formatError(err)));
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-lg shadow-xl w-[560px] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-text">Acknowledgements</h2>
            <p className="text-xs text-muted">Third-party libraries this app is built on.</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text transition-colors" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
          {error && <div className="text-xs text-danger px-1">{error}</div>}
          {!licenses && !error && <div className="text-xs text-muted px-1">Loading…</div>}
          {licenses && (
            <>
              <LicenseTable title="Python" entries={licenses.python} />
              <LicenseTable title="npm" entries={licenses.npm} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
