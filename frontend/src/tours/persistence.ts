// Completion state for first-visit auto-start. localStorage keeps it lightweight
// and per-device, matching how the theme preference is stored.
const KEY_PREFIX = 'sds-tour:';

export function completedVersion(tourId: string): number {
  const raw = localStorage.getItem(KEY_PREFIX + tourId);
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) ? v : 0;
}

export function markCompleted(tourId: string, version: number): void {
  localStorage.setItem(KEY_PREFIX + tourId, String(version));
}

export function resetTour(tourId: string): void {
  localStorage.removeItem(KEY_PREFIX + tourId);
}
