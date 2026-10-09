import { useEffect, useState } from 'react';
import { getPythonLicenses, type ThirdPartyLicense } from '../api';
import { formatError } from '@cirrobio/spatial-viewer';
import { ModalOverlay, ModalHeader } from './DetailModal';

interface Props {
  /** False in serverless mode, where there is no backend to list its Python packages. */
  withBackend: boolean;
  onClose: () => void;
}

// The npm list ships inside the SPA (a lazy chunk, read at build time from the committed
// SBOM) rather than coming from the backend, so a serverless deployment can show it too.
async function npmLicenses(): Promise<ThirdPartyLicense[]> {
  const { components } = await import('../../../sds-governance/sbom_frontend.json');
  return components
    .map((c) => ({ name: c.name, version: c.version, license: c.licenses[0]?.license.name ?? 'UNKNOWN' }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

function LicenseTable({ title, entries }: { title: string; entries: ThirdPartyLicense[] }) {
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-semibold text-text mb-1 hover:text-accent transition-colors"
        aria-expanded={open}
      >
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        {title} ({entries.length})
      </button>
      {open && (
        <div className="border border-border rounded-md divide-y divide-border">
          {entries.map((e) => (
            <div key={`${e.name}@${e.version}`} className="flex items-center justify-between gap-3 px-2.5 py-1 text-xs">
              <span className="font-mono text-text truncate">{e.name}</span>
              <span className="text-muted shrink-0">{e.version}</span>
              <span className="text-muted shrink-0 w-32 text-right truncate" title={e.license}>{e.license}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AcknowledgementsDialog({ withBackend, onClose }: Props) {
  const [licenses, setLicenses] = useState<{ python: ThirdPartyLicense[]; npm: ThirdPartyLicense[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([npmLicenses(), withBackend ? getPythonLicenses().then((r) => r.python) : []])
      .then(([npm, python]) => setLicenses({ python, npm }))
      .catch((err) => setError(formatError(err)));
  }, [withBackend]);

  return (
    <ModalOverlay onClose={onClose} widthClassName="w-[560px]">
      <ModalHeader title="Acknowledgements" subtitle="Third-party libraries this app is built on." onClose={onClose} />

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
    </ModalOverlay>
  );
}
