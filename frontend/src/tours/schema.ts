// Tour config shape. Library-agnostic on purpose: the renderer (Driver.js) sits
// behind the controller, so switching libraries is a controller change, not a
// config migration. Configs are authored in-repo and validated by the compiler
// plus `defineTour` (which fills defaults) — see spatial-data-studio.tour.ts.
import type { TourAnchor } from './anchors';

// How a step finds the element it describes.
export type Target =
  // Preferred: stable data-tour anchor → resolves to [data-tour="<value>"].
  | { kind: 'anchor'; value: TourAnchor }
  // Escape hatch for elements you don't control (3rd-party widgets, canvas
  // overlays). These are the brittle ones — use sparingly.
  | { kind: 'selector'; css: string }
  // No element: a viewport-centered card (intro/outro steps).
  | { kind: 'center' };

export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'auto';

export interface TourStepInput {
  /** Stable id, used for analytics and to key the step. */
  id: string;
  target: Target;
  title: string;
  /** Body copy. Plain text; rendered as-is by the adapter. */
  body: string;
  placement?: Placement;
  /** If the target isn't in the DOM, skip this step instead of stalling. */
  optional?: boolean;
  /** Poll for the target up to this many ms before showing. 0 = don't wait. */
  waitForMs?: number;
  /** What advances the tour from this step. */
  advanceOn?: 'next-button' | 'target-click';
  /** Let the user interact with the highlighted element mid-step. */
  allowInteraction?: boolean;
}

export interface TourInput {
  id: string;
  /** Bump when steps change materially; a user who finished an older version is
   *  re-shown the updated tour on first visit. */
  version?: number;
  title: string;
  steps: TourStepInput[];
  showProgress?: boolean;
  allowClose?: boolean;
  keyboardControl?: boolean;
  /** "first-visit" auto-starts once per version; "manual" only via startTour(). */
  trigger?: 'first-visit' | 'manual';
}

export type TourStep = Required<Omit<TourStepInput, 'target' | 'title' | 'body' | 'id'>> &
  Pick<TourStepInput, 'target' | 'title' | 'body' | 'id'>;

export interface Tour {
  id: string;
  version: number;
  title: string;
  steps: TourStep[];
  showProgress: boolean;
  allowClose: boolean;
  keyboardControl: boolean;
  trigger: 'first-visit' | 'manual';
}

export function defineTour(input: TourInput): Tour {
  return {
    id: input.id,
    version: input.version ?? 1,
    title: input.title,
    showProgress: input.showProgress ?? true,
    allowClose: input.allowClose ?? true,
    keyboardControl: input.keyboardControl ?? true,
    trigger: input.trigger ?? 'manual',
    steps: input.steps.map((s) => ({
      id: s.id,
      target: s.target,
      title: s.title,
      body: s.body,
      placement: s.placement ?? 'auto',
      optional: s.optional ?? false,
      waitForMs: s.waitForMs ?? 0,
      advanceOn: s.advanceOn ?? 'next-button',
      allowInteraction: s.allowInteraction ?? false,
    })),
  };
}
