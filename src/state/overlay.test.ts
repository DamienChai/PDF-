import { describe, expect, it } from 'vitest';
import { createOverlayController } from './overlay';

/** A session history that behaves like the browser's: `back()` takes effect asynchronously. */
function fakeHistory() {
  const events = new EventTarget();
  const entries: unknown[] = [null];
  let index = 0;
  const pendingTraversals: Array<() => void> = [];
  const history = {
    get state() {
      return entries[index];
    },
    pushState(state: unknown) {
      entries.splice(index + 1, entries.length, state);
      index++;
    },
    back() {
      pendingTraversals.push(() => {
        if (index === 0) return;
        index--;
        events.dispatchEvent(new Event('popstate'));
      });
    },
  };
  return {
    history,
    events,
    length: () => entries.length,
    index: () => index,
    /** Runs the traversals requested so far, like the browser's event loop would. */
    flush: () => {
      while (pendingTraversals.length > 0) pendingTraversals.shift()!();
    },
    /** The user presses "back" or swipes back. */
    userBack: () => {
      history.back();
      while (pendingTraversals.length > 0) pendingTraversals.shift()!();
    },
  };
}

function setup() {
  const browser = fakeHistory();
  const controller = createOverlayController({ history: browser.history, events: browser.events });
  const detach = controller.attach();
  return { ...browser, controller, detach };
}

describe('overlay', () => {
  it('opens settings and details, one at a time', () => {
    const { controller } = setup();
    expect(controller.overlay.value).toBeNull();
    controller.openSettings();
    expect(controller.overlay.value).toEqual({ kind: 'settings' });
    controller.openDetails('f3');
    expect(controller.overlay.value).toEqual({ kind: 'details', entryId: 'f3' });
  });

  it('opens the action menu of a file, and details from it without another history entry', () => {
    const { controller, index, userBack } = setup();
    controller.openMenu('f2');
    expect(controller.overlay.value).toEqual({ kind: 'menu', entryId: 'f2' });
    expect(index()).toBe(1);
    controller.openDetails('f2');
    expect(controller.overlay.value).toEqual({ kind: 'details', entryId: 'f2' });
    expect(index()).toBe(1);
    userBack();
    expect(controller.overlay.value).toBeNull();
    expect(index()).toBe(0);
  });

  it('closes the menu on the back gesture', () => {
    const { controller, userBack, index } = setup();
    controller.openMenu('f1');
    userBack();
    expect(controller.overlay.value).toBeNull();
    expect(index()).toBe(0);
  });

  it('gives an open overlay one history entry', () => {
    const { controller, index, history } = setup();
    controller.openSettings();
    expect(index()).toBe(1);
    expect(history.state).toEqual({ pdfkeyOverlay: true });
    // Replacing the overlay does not stack another entry.
    controller.openDetails('f1');
    expect(index()).toBe(1);
  });

  it('closes on the back gesture', () => {
    const { controller, userBack, index } = setup();
    controller.openDetails('f1');
    userBack();
    expect(controller.overlay.value).toBeNull();
    expect(index()).toBe(0);
  });

  it('removes its history entry when closed from the UI', () => {
    const { controller, flush, index } = setup();
    controller.openSettings();
    controller.close();
    // Closed at once, not when the browser has gone back.
    expect(controller.overlay.value).toBeNull();
    flush();
    expect(index()).toBe(0);
    expect(controller.overlay.value).toBeNull();
  });

  it('can be opened and closed again and again without piling up history', () => {
    const { controller, flush, index, userBack } = setup();
    for (let i = 0; i < 3; i++) {
      controller.openSettings();
      controller.close();
      flush();
    }
    expect(index()).toBe(0);
    controller.openSettings();
    userBack();
    expect(index()).toBe(0);
    expect(controller.overlay.value).toBeNull();
  });

  it('survives reopening before the browser has finished going back', () => {
    const { controller, flush, index, userBack } = setup();
    controller.openSettings();
    controller.close();
    controller.openDetails('f2');
    flush();
    // Still open, and it has its history entry again.
    expect(controller.overlay.value).toEqual({ kind: 'details', entryId: 'f2' });
    expect(index()).toBe(1);
    userBack();
    expect(controller.overlay.value).toBeNull();
    expect(index()).toBe(0);
  });

  it('survives closing, reopening and closing in one go', () => {
    const { controller, flush, index } = setup();
    controller.openSettings();
    controller.close();
    controller.openSettings();
    controller.close();
    flush();
    expect(controller.overlay.value).toBeNull();
    expect(index()).toBe(0);
  });

  it('keeps what other code stored in the history state', () => {
    const { controller, history } = setup();
    history.pushState({ scroll: 120 });
    controller.openSettings();
    expect(history.state).toEqual({ scroll: 120, pdfkeyOverlay: true });
  });

  it('ignores a back gesture when nothing is open', () => {
    const { controller, history, userBack } = setup();
    history.pushState({ other: true });
    userBack();
    expect(controller.overlay.value).toBeNull();
  });

  it('does nothing when closing what is not open', () => {
    const { controller, flush, index } = setup();
    controller.close();
    flush();
    expect(index()).toBe(0);
  });

  it('stops following the history when detached', () => {
    const { controller, detach, userBack } = setup();
    controller.openSettings();
    detach();
    userBack();
    expect(controller.overlay.value).toEqual({ kind: 'settings' });
  });

  it('works without a history, and with one that throws', () => {
    const bare = createOverlayController(null);
    bare.attach()();
    bare.openSettings();
    expect(bare.overlay.value).toEqual({ kind: 'settings' });
    bare.close();
    expect(bare.overlay.value).toBeNull();

    const hostile = createOverlayController({
      history: {
        state: null,
        pushState: () => {
          throw new DOMException('insecure', 'SecurityError');
        },
        back: () => {
          throw new Error('should not be called: nothing was pushed');
        },
      },
      events: new EventTarget(),
    });
    hostile.openDetails('f1');
    expect(hostile.overlay.value).toEqual({ kind: 'details', entryId: 'f1' });
    expect(() => hostile.close()).not.toThrow();
    expect(hostile.overlay.value).toBeNull();
  });
});
