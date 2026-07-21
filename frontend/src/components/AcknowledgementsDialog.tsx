import { useEffect, useState } from 'react';
import { getThirdPartyLicenses, type ThirdPartyLicense } from '../api';
import { formatError } from '../lib/format';
import { ModalOverlay, ModalHeader } from './DetailModal';

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
    <ModalOverlay onClose={onClose} widthClassName="w-[560px] max-h-[80vh]">
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
