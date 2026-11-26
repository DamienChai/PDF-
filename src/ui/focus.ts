/** Focus helpers shared by the overlays and the action area. */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getClientRects().length > 0,
  );
}

/** Keeps Tab inside `root`. Call from a keydown handler on it. */
export function trapTab(event: KeyboardEvent, root: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const items = focusableWithin(root);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    event.preventDefault();
    root.focus();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === root)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Moves the focus without scrolling the page: the browser brings a focused field into view by
 * itself when the keyboard opens, and anything else would yank the viewport.
 */
export function focusQuietly(element: HTMLElement | null | undefined, select = false): void {
  if (!element) return;
  element.focus({ preventScroll: true });
  if (select && element instanceof HTMLInputElement) element.select();
}

/** Runs `callback` once the pending render has reached the DOM. */
export function afterRender(callback: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

let opener: HTMLElement | null = null;

/**
 * Remembers what had the focus when an overlay opened and returns the function that gives it
 * back. An overlay opened from another one (details from the menu) returns to the control that
 * opened the first.
 */
export function rememberFocus(): () => void {
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    !active.closest('.modal, .menu')
  ) {
    opener = active;
  }
  const target = opener;
  return () => {
    if (target && target.isConnected && target.getClientRects().length > 0) {
      target.focus({ preventScroll: true });
    } else {
      // Its opener is gone (the file was removed): the page itself, so that Tab starts there.
      document.getElementById('main')?.focus({ preventScroll: true });
    }
  };
}
