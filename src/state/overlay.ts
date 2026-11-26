/**
 * Which sheet, dialog or menu is open: settings, the details of one file, or the action menu of
 * one file (an action sheet on the phone). One at a time.
 *
 * An open overlay owns one history entry, so that the Android back gesture (and the browser's
 * back button) closes it instead of leaving the app.
 */
import { signal, type ReadonlySignal } from '@preact/signals';

export type Overlay =
  { kind: 'settings' } | { kind: 'details'; entryId: string } | { kind: 'menu'; entryId: string };

export interface OverlayController {
  readonly overlay: ReadonlySignal<Overlay | null>;
  openSettings(): void;
  openDetails(entryId: string): void;
  /** Opens the action menu of a file. Opening details from it replaces it in place. */
  openMenu(entryId: string): void;
  /** Closes whatever is open. For the close button, the scrim and the Escape key. */
  close(): void;
  /** Starts listening for the back gesture. Returns a function that stops listening. */
  attach(): () => void;
}

/** The parts of `window` this module uses; replaced by fakes in tests. */
export interface OverlayEnvironment {
  history: {
    readonly state: unknown;
    pushState(state: unknown, unused: string): void;
    back(): void;
  };
  /** Receives `popstate` (the window). */
  events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}

/** Marks the history entry of an open overlay. */
const STATE_KEY = 'pdfkeyOverlay';

export function createOverlayController(env: OverlayEnvironment | null): OverlayController {
  const overlay = signal<Overlay | null>(null);
  /** The current history entry was pushed for the overlay that is open. */
  let pushed = false;
  /** `history.back()` calls of ours whose `popstate` has not arrived yet. */
  let pendingBacks = 0;

  function push(): void {
    if (!env) return;
    try {
      const current = env.history.state;
      const base = typeof current === 'object' && current !== null ? current : {};
      env.history.pushState({ ...base, [STATE_KEY]: true }, '');
      pushed = true;
    } catch {
      // History unavailable (sandboxed frame, too many calls): the back gesture leaves the app.
      pushed = false;
    }
  }

  function open(next: Overlay): void {
    overlay.value = next;
    // While a back of ours is under way the entry would be pushed on top of the one that is
    // about to be left; `onPopState` pushes it once that has happened.
    if (!pushed && pendingBacks === 0) push();
  }

  function close(): void {
    if (overlay.peek() === null) return;
    overlay.value = null;
    if (!pushed || !env) return;
    pushed = false;
    pendingBacks++;
    try {
      env.history.back();
    } catch {
      pendingBacks--;
    }
  }

  function onPopState(): void {
    if (pendingBacks > 0) {
      // The echo of our own `back()`, not the user.
      pendingBacks--;
      if (pendingBacks === 0 && overlay.peek() !== null && !pushed) push();
      return;
    }
    // The user went back: the entry is gone, and so is the overlay.
    pushed = false;
    overlay.value = null;
  }

  return {
    overlay,
    openSettings: () => open({ kind: 'settings' }),
    openDetails: (entryId) => open({ kind: 'details', entryId }),
    openMenu: (entryId) => open({ kind: 'menu', entryId }),
    close,
    attach() {
      if (!env) return () => undefined;
      env.events.addEventListener('popstate', onPopState);
      return () => env.events.removeEventListener('popstate', onPopState);
    },
  };
}
