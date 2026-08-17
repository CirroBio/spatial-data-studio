/** Hand a blob to the browser as a file download. Shared by the canvas PNG capture and
 * the plot-figure exports, which both have bytes in hand rather than a URL to link to. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    // Revoke after the click has been dispatched; doing it synchronously can cancel
    // the download in Safari.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
