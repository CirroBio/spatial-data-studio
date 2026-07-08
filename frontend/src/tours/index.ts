import { useCallback, useEffect, useRef } from 'react';
import { createTourController, type TourController } from './controller';
import { spatialDataStudioTour } from './spatial-data-studio.tour';
import { completedVersion, resetTour } from './persistence';
import type { Tour } from './schema';

export { TourAnchors, type TourAnchor } from './anchors';
export { spatialDataStudioTour } from './spatial-data-studio.tour';

// Registry of known tours, keyed by id. Add tours here as they are authored.
const TOURS: Record<string, Tour> = {
  [spatialDataStudioTour.id]: spatialDataStudioTour,
};

/** Imperatively start a tour (e.g. from a "Take the tour" button). */
export function startTour(tourId: string): void {
  const tour = TOURS[tourId];
  if (!tour) throw new Error(`Unknown tour: ${tourId}`);
  createTourController(tour).start();
}

export { resetTour };

/** React glue: returns a `start` callback and auto-starts a `first-visit` tour
 *  once per version when `enabled` becomes true. */
export function useTour(tourId: string, enabled: boolean) {
  const controllerRef = useRef<TourController | null>(null);
  const startedRef = useRef(false);
  const tour = TOURS[tourId];
  if (!tour) throw new Error(`Unknown tour: ${tourId}`);

  const start = useCallback(() => {
    controllerRef.current?.destroy();
    const controller = createTourController(tour);
    controllerRef.current = controller;
    controller.start();
  }, [tour]);

  useEffect(() => {
    if (!enabled || startedRef.current) return;
    if (tour.trigger !== 'first-visit') return;
    // Don't hijack automated browsers (Playwright): the overlay would intercept
    // the clicks every e2e test makes. Real users still get the first-visit tour,
    // and the manual "Take the tour" button works everywhere.
    if (navigator.webdriver) return;
    if (completedVersion(tour.id) >= tour.version) return;
    startedRef.current = true;
    start();
  }, [enabled, tour, start]);

  return { start };
}
