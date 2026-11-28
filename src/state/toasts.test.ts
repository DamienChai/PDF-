import { describe, expect, it, vi } from 'vitest';
import { msg } from '../i18n';
import {
  MAX_TOASTS,
  TOAST_DURATION_MS,
  TOAST_LONG_DURATION_MS,
  createToastQueue,
  type ToastClock,
} from './toasts';

/** A clock that only moves when the test says so. */
function fakeClock() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: ToastClock = {
    setTimeout(callback, ms) {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    now: () => now,
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(handle);
        timer.callback();
      }
    }
  };
  return { clock, advance, pending: () => timers.size };
}

function setup() {
  const time = fakeClock();
  const queue = createToastQueue(time.clock);
  const keys = (): string[] => queue.toasts.value.map((toast) => toast.message.key);
  return { ...time, queue, keys };
}

describe('toast queue', () => {
  it('shows a toast and removes it after its time', () => {
    const { queue, advance, keys } = setup();
    const id = queue.show(msg('toast.saved'), { tone: 'success' });
    expect(queue.toasts.value).toEqual([
      {
        id,
        key: 'toast.saved',
        message: { key: 'toast.saved' },
        tone: 'success',
        action: null,
        sticky: false,
      },
    ]);
    advance(TOAST_DURATION_MS - 1);
    expect(keys()).toEqual(['toast.saved']);
    advance(1);
    expect(keys()).toEqual([]);
  });

  it('gives errors and toasts with an action more time', () => {
    const { queue, advance, keys } = setup();
    queue.show(msg('toast.saveFailed'), { tone: 'error' });
    queue.show(msg('toast.engineUnavailable'), {
      action: { label: msg('toast.retry'), run: () => undefined },
    });
    advance(TOAST_DURATION_MS);
    expect(keys()).toHaveLength(2);
    advance(TOAST_LONG_DURATION_MS - TOAST_DURATION_MS);
    expect(keys()).toEqual([]);
  });

  it('keeps a toast with duration 0 until it is dismissed', () => {
    const { queue, advance, pending } = setup();
    const id = queue.show(msg('toast.update'), { duration: 0 });
    expect(queue.toasts.value[0]!.sticky).toBe(true);
    expect(pending()).toBe(0);
    advance(60 * 60 * 1000);
    expect(queue.toasts.value).toHaveLength(1);
    queue.dismiss(id);
    expect(queue.toasts.value).toEqual([]);
  });

  it('replaces a toast with the same message instead of stacking it', () => {
    const { queue, advance, keys } = setup();
    const first = queue.show(msg('toast.saved'));
    advance(TOAST_DURATION_MS - 100);
    const second = queue.show(msg('toast.saved'));
    expect(second).toBe(first);
    expect(keys()).toEqual(['toast.saved']);
    // The timer started again.
    advance(TOAST_DURATION_MS - 100);
    expect(keys()).toEqual(['toast.saved']);
    advance(100);
    expect(keys()).toEqual([]);
  });

  it('treats the same key with different parameters as different toasts', () => {
    const { queue } = setup();
    queue.show(msg('toast.notPdf', { name: 'a.txt' }));
    queue.show(msg('toast.notPdf', { name: 'b.txt' }));
    expect(queue.toasts.value).toHaveLength(2);
  });

  it('replaces by explicit key, keeping the place and taking the newer action', () => {
    const { queue } = setup();
    const older = vi.fn();
    const newer = vi.fn();
    const id = queue.show(msg('toast.update'), {
      key: 'update',
      duration: 0,
      action: { label: msg('toast.update.action'), run: older },
    });
    queue.show(msg('toast.saved'));
    queue.show(msg('toast.update'), {
      key: 'update',
      duration: 0,
      action: { label: msg('toast.update.action'), run: newer },
    });
    expect(queue.toasts.value.map((toast) => toast.key)).toEqual(['update', 'toast.saved']);
    queue.runAction(id);
    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledTimes(1);
    expect(queue.toasts.value.map((toast) => toast.key)).toEqual(['toast.saved']);
  });

  it('dismisses before running the action, so the action may show a toast itself', () => {
    const { queue, keys } = setup();
    const id = queue.show(msg('toast.engineUnavailable'), {
      action: { label: msg('toast.retry'), run: () => queue.show(msg('toast.engineUnavailable')) },
    });
    queue.runAction(id);
    expect(keys()).toEqual(['toast.engineUnavailable']);
    expect(queue.toasts.value[0]!.id).not.toBe(id);
  });

  it('ignores unknown ids', () => {
    const { queue } = setup();
    queue.show(msg('toast.saved'));
    expect(() => {
      queue.dismiss(99);
      queue.runAction(99);
      queue.pause(99);
      queue.resume(99);
    }).not.toThrow();
    expect(queue.toasts.value).toHaveLength(1);
  });

  it('does not notify when dismissing something that is already gone', () => {
    const { queue } = setup();
    const id = queue.show(msg('toast.saved'));
    queue.dismiss(id);
    let notifications = -1;
    queue.toasts.subscribe(() => notifications++);
    queue.dismiss(id);
    expect(notifications).toBe(0);
  });

  it('drops the oldest self-dismissing toast when there are too many', () => {
    const { queue, keys } = setup();
    queue.show(msg('toast.update'), { duration: 0 });
    queue.show(msg('toast.saved'));
    queue.show(msg('toast.copied'));
    queue.show(msg('toast.downloaded'));
    expect(queue.toasts.value).toHaveLength(MAX_TOASTS);
    expect(keys()).toEqual(['toast.update', 'toast.copied', 'toast.downloaded']);
  });

  it('pauses and resumes the countdown', () => {
    const { queue, advance, keys } = setup();
    const id = queue.show(msg('toast.saved'));
    advance(1000);
    queue.pause(id);
    queue.pause(id);
    advance(60_000);
    expect(keys()).toEqual(['toast.saved']);
    queue.resume(id);
    queue.resume(id);
    advance(TOAST_DURATION_MS - 1000 - 1);
    expect(keys()).toEqual(['toast.saved']);
    advance(1);
    expect(keys()).toEqual([]);
  });

  it('leaves at least a second after resuming', () => {
    const { queue, advance, keys } = setup();
    const id = queue.show(msg('toast.saved'));
    advance(TOAST_DURATION_MS - 10);
    queue.pause(id);
    queue.resume(id);
    advance(999);
    expect(keys()).toEqual(['toast.saved']);
    advance(1);
    expect(keys()).toEqual([]);
  });

  it('puts a background toast under what is on screen, and starts its time when it is seen', () => {
    const { queue, advance, keys } = setup();
    advance(171);
    queue.show(msg('toast.folderLimit'));
    advance(168);
    queue.show(msg('toast.offlineReady'), { tone: 'success', background: true });
    // Oldest first, and the last one is on screen: the notice the user has to read.
    expect(keys()).toEqual(['toast.offlineReady', 'toast.folderLimit']);
    advance(TOAST_DURATION_MS - 168 - 1);
    expect(keys()).toEqual(['toast.offlineReady', 'toast.folderLimit']);
    advance(1);
    expect(keys()).toEqual(['toast.offlineReady']);
    advance(TOAST_DURATION_MS - 1);
    expect(keys()).toEqual(['toast.offlineReady']);
    advance(1);
    expect(keys()).toEqual([]);
  });

  it('starts the time of a background toast when what was above it is dismissed', () => {
    const { queue, advance, keys, pending } = setup();
    const error = queue.show(msg('toast.saveFailed'), { tone: 'error' });
    const waiting = queue.show(msg('toast.offlineReady'), { background: true });
    expect(pending()).toBe(1);
    // Nothing a pointer does can start it early: it is not on screen.
    queue.pause(waiting);
    queue.resume(waiting);
    expect(pending()).toBe(1);
    advance(60);
    queue.dismiss(error);
    expect(keys()).toEqual(['toast.offlineReady']);
    advance(TOAST_DURATION_MS - 1);
    expect(keys()).toEqual(['toast.offlineReady']);
    advance(1);
    expect(keys()).toEqual([]);
    expect(pending()).toBe(0);
  });

  it('shows a background toast like any other when nothing is on screen', () => {
    const { queue, advance, keys } = setup();
    queue.show(msg('toast.offlineReady'), { background: true });
    // What comes later covers it, as it covers any toast.
    queue.show(msg('toast.saved'));
    expect(keys()).toEqual(['toast.offlineReady', 'toast.saved']);
    advance(TOAST_DURATION_MS);
    expect(keys()).toEqual([]);
  });

  it('clears everything and cancels the timers', () => {
    const { queue, pending } = setup();
    queue.show(msg('toast.saved'));
    queue.show(msg('toast.copied'));
    queue.clear();
    expect(queue.toasts.value).toEqual([]);
    expect(pending()).toBe(0);
  });
});
