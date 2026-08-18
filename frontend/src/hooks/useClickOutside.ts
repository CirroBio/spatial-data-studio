import { useEffect, type RefObject } from 'react';

/** Close an open popover when the next mousedown lands outside `ref`.
 *
 * The listener is only attached while `open`, so a closed dropdown costs nothing. Shared
 * by the components that open a panel over the page (the obs/var pickers, the lock
 * badge) — the effect was previously copied into each one, so any correction to it (the
 * event to listen for, the capture phase, handling portalled children) had to be made in
 * every copy to take effect. */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  close: () => void,
  open: boolean,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [ref, close, open]);
}
