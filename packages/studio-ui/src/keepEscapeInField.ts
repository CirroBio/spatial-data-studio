import type { KeyboardEvent } from 'react';

/** Stop an Escape pressed in a form field from reaching the page.
 *
 * Both apps act on Escape at the window (the web app leaves the dataset, the Studio closes
 * its detail panels), so an Escape meant to close a dropdown would also do that. Attach it
 * to the element that holds the fields; an Escape from anything else, such as a button,
 * still reaches the page. */
export function keepEscapeInField(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) {
    e.stopPropagation();
    e.preventDefault();
  }
}
