import { driver, type Driver, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';
import './tour.css';
import type { Tour, TourStep } from './schema';
import { markCompleted } from './persistence';

// Driver.js handles the spotlight, popover, and positioning. The behaviors it
// doesn't own — waiting for async targets, skipping missing ones, and advancing
// on a click of the highlighted element — live here so they stay independent of
// the renderer.

function toSelector(step: TourStep): string | undefined {
  const t = step.target;
  if (t.kind === 'anchor') return `[data-tour="${t.value}"]`;
  if (t.kind === 'selector') return t.css;
  return undefined; // center → no element
}

// Poll for a selector until present or timed out. timeoutMs = 0 checks once.
function waitForElement(selector: string, timeoutMs: number): Promise<Element | null> {
  const existing = document.querySelector(selector);
  if (existing || timeoutMs <= 0) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (performance.now() - start >= timeoutMs) return resolve(null);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function buildDriveStep(step: TourStep): DriveStep {
  const interactive = step.allowInteraction || step.advanceOn === 'target-click';
  return {
    element: toSelector(step),
    disableActiveInteraction: !interactive,
    popover: {
      title: step.title,
      description: step.body,
      side: step.placement === 'auto' ? undefined : step.placement,
      align: 'start',
      // On target-click steps, hide Next so the highlighted element is the only
      // way forward.
      showButtons:
        step.advanceOn === 'target-click' ? ['previous', 'close'] : undefined,
    },
    data: { advanceOn: step.advanceOn },
  };
}

export interface TourController {
  start: () => void;
  destroy: () => void;
}

export function createTourController(
  tour: Tour,
  hooks: { onStepShown?: (id: string) => void; onDone?: () => void } = {},
): TourController {
  const steps = tour.steps;
  let driverObj: Driver | null = null;
  let clickTarget: { el: Element; handler: EventListener } | null = null;

  const clearClickAdvance = () => {
    if (clickTarget) {
      clickTarget.el.removeEventListener('click', clickTarget.handler);
      clickTarget = null;
    }
  };

  // Resolve the next step to show in `direction`, waiting for and skipping over
  // missing targets. Destroys the tour when it runs off either end.
  async function goTo(index: number, direction: 1 | -1) {
    if (!driverObj) return;
    let i = index;
    while (i >= 0 && i < steps.length) {
      const step = steps[i];
      const selector = toSelector(step);
      if (!selector) break; // center step, always shows
      const el = await waitForElement(selector, step.waitForMs);
      if (el) break;
      if (!step.optional) {
        console.warn(`[tour] required target missing, skipping: ${selector}`);
      }
      i += direction;
    }
    if (i < 0 || i >= steps.length) {
      driverObj.destroy();
      return;
    }
    driverObj.moveTo(i);
  }

  driverObj = driver({
    steps: steps.map(buildDriveStep),
    showProgress: tour.showProgress,
    allowClose: tour.allowClose,
    allowKeyboardControl: tour.keyboardControl,
    stagePadding: 6,
    overlayClickBehavior: 'close',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    onHighlighted: (element) => {
      const active = driverObj?.getActiveStep();
      const idx = driverObj?.getActiveIndex();
      if (idx !== undefined) hooks.onStepShown?.(steps[idx].id);
      // Wire click-to-advance for target-click steps.
      clearClickAdvance();
      if (active?.data?.advanceOn === 'target-click' && element && idx !== undefined) {
        const handler = () => goTo(idx + 1, 1);
        element.addEventListener('click', handler, { once: true });
        clickTarget = { el: element, handler };
      }
    },
    onDeselected: clearClickAdvance,
    onNextClick: () => {
      // getActiveIndex is undefined mid-transition; ignore clicks until settled
      // rather than falling back to a wrong index.
      const cur = driverObj?.getActiveIndex();
      if (cur === undefined) return;
      if (cur >= steps.length - 1) driverObj?.destroy();
      else goTo(cur + 1, 1);
    },
    onPrevClick: () => {
      const cur = driverObj?.getActiveIndex();
      if (cur === undefined) return;
      goTo(cur - 1, -1);
    },
    onCloseClick: () => driverObj?.destroy(),
    onDestroyed: () => {
      clearClickAdvance();
      markCompleted(tour.id, tour.version);
      hooks.onDone?.();
    },
  });

  return {
    start: () => {
      // Find the first showable step so we never open on a missing target.
      void (async () => {
        let i = 0;
        while (i < steps.length) {
          const selector = toSelector(steps[i]);
          if (!selector || (await waitForElement(selector, steps[i].waitForMs))) break;
          i += 1;
        }
        if (i < steps.length) driverObj?.drive(i);
      })();
    },
    destroy: () => driverObj?.destroy(),
  };
}
