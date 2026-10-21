// What this app is, which version, and whose methods it follows: the top bar's About.
import { useEffect } from 'react';
import { APP_NAME, APP_VERSION, CIRRO_URL, DOCS_URL, REPO_URL } from './appInfo';

// The methods the analyses follow and the format they read, cited as the Studio cites
// them (backend/app/registry/library_meta.yaml, custom/cluster_leiden.py).
const CITATIONS = [
  'Wolf, F.A., Angerer, P. & Theis, F.J. SCANPY: large-scale single-cell gene expression data analysis. Genome Biol 19, 15 (2018). doi:10.1186/s13059-017-1382-0',
  'Palla, G., Spitzer, H., Klein, M. et al. Squidpy: a scalable framework for spatial omics analysis. Nat Methods 19, 171-178 (2022). doi:10.1038/s41592-021-01358-2',
  'Traag, V.A., Waltman, L. & van Eck, N.J. From Louvain to Leiden: guaranteeing well-connected communities. Sci Rep 9, 5233 (2019). doi:10.1038/s41598-019-41695-z',
  'Marconato, L., Palla, G., Yamauchi, K.A. et al. SpatialData: an open and universal data framework for spatial omics. Nat Methods 22, 58-62 (2025). doi:10.1038/s41592-024-02212-x',
];

export function About({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`About ${APP_NAME}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal about">
        <div>
          <h2>{APP_NAME}</h2>
          <p className="muted">Version {APP_VERSION}</p>
        </div>
        <p>
          Opens the SpatialData stores in your Cirro projects in this browser, reading only the parts on screen. The
          analyses run here too, and each result is saved back to Cirro as a version: a dataset that holds only what
          changed, on top of the store it was made from.
        </p>
        <div>
          <h3>Methods</h3>
          <p className="muted">The analyses follow scanpy and squidpy, and are tested against them.</p>
          <ul className="about-citations">{CITATIONS.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
        <p className="button-row">
          <a href={DOCS_URL} target="_blank" rel="noreferrer">How it works ↗</a>
          <a href={REPO_URL} target="_blank" rel="noreferrer">Source ↗</a>
          <a href={CIRRO_URL} target="_blank" rel="noreferrer">Cirro ↗</a>
          <span className="shell-spacer" />
          <button type="button" className="button" onClick={onClose}>Close</button>
        </p>
      </div>
    </div>
  );
}
