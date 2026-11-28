/**
 * Toast / snackbar queue. Holds untranslated messages; the component translates them with `t()`
 * so that a toast on screen follows a language change.
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import type { Message } from '../i18n';

export type ToastTone = 'neutral' | 'success' | 'error';

export interface ToastAction {
  label: Message;
  /** Runs when the user chooses the action; the toast is dismissed first. */
  run: () => void;
}

export interface ToastOptions {
  tone?: ToastTone;
  action?: ToastAction;
  /**
   * Toasts with the same key replace each other instead of piling up. Default: the message
   * itself, so showing the same text twice only restarts its timer.
   */
  key?: string;
  /** Milliseconds until it disappears by itself; `0` keeps it until dismissed. */
  duration?: number;
  /**
   * An announcement nobody is waiting for (the app is ready to work offline): it does not cover
   * the toasts that are on screen, which may answer something the user just did. It takes its
   * place under them, and its time starts when they have gone.
   */
  background?: boolean;
}

export interface Toast {
  /** Stable for the lifetime of the toast, also when it is replaced through its key. */
  readonly id: number;
  readonly key: string;
  readonly message: Message;
  readonly tone: ToastTone;
  readonly action: ToastAction | null;
  /** Stays until dismissed. */
  readonly sticky: boolean;
}

export interface ToastQueue {
  /** Oldest first. */
  readonly toasts: ReadonlySignal<readonly Toast[]>;
  show(message: Message, options?: ToastOptions): number;
  dismiss(id: number): void;
  /** Runs the toast's action (if it has one) and dismisses it. */
  runAction(id: number): void;
  /** Stops the countdown, e.g. while the pointer or the focus is on the toast. */
  pause(id: number): void;
  resume(id: number): void;
  clear(): void;
}

/** Timers; replaced by fakes in tests. */
export interface ToastClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const TOAST_DURATION_MS = 4000;
/** Errors and toasts that offer an action need more time to be read and reached. */
export const TOAST_LONG_DURATION_MS = 8000;
/** More than this many at once is noise: the oldest self-dismissing one makes room. */
export const MAX_TOASTS = 3;

interface Timer {
  handle: unknown;
  remaining: number;
  startedAt: number;
  paused: boolean;
  /** Not started yet: a background toast under the toasts it did not cover. */
  waiting: boolean;
}

const systemClock: ToastClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

function defaultKey(message: Message): string {
  return message.params ? `${message.key}:${JSON.stringify(message.params)}` : message.key;
}

export function createToastQueue(clock: ToastClock = systemClock): ToastQueue {
  const toasts = signal<readonly Toast[]>([]);
  const timers = new Map<number, Timer>();
  let nextId = 1;

  function stopTimer(id: number): void {
    const timer = timers.get(id);
    if (timer && !timer.paused) clock.clearTimeout(timer.handle);
    timers.delete(id);
  }

  function dismiss(id: number): void {
    stopTimer(id);
    if (toasts.peek().some((toast) => toast.id === id)) {
      toasts.value = toasts.peek().filter((toast) => toast.id !== id);
    }
    startWaiting();
  }

  function arm(id: number, timer: Timer): void {
    timer.paused = false;
    timer.waiting = false;
    timer.startedAt = clock.now();
    timer.handle = clock.setTimeout(() => dismiss(id), timer.remaining);
  }

  /** `waiting`: the countdown begins when the toast is the one on top (see `background`). */
  function startTimer(id: number, duration: number, waiting = false): void {
    stopTimer(id);
    if (duration <= 0) return;
    const timer: Timer = {
      handle: undefined,
      remaining: duration,
      startedAt: 0,
      paused: waiting,
      waiting,
    };
    timers.set(id, timer);
    if (!waiting) arm(id, timer);
  }

  /** The toast on top is the one on screen: if its time has not begun yet, it begins now. */
  function startWaiting(): void {
    const top = toasts.peek().at(-1);
    const timer = top ? timers.get(top.id) : undefined;
    if (top && timer?.waiting) arm(top.id, timer);
  }

  function show(message: Message, options: ToastOptions = {}): number {
    const tone = options.tone ?? 'neutral';
    const action = options.action ?? null;
    const key = options.key ?? defaultKey(message);
    const duration =
      options.duration ?? (action || tone === 'error' ? TOAST_LONG_DURATION_MS : TOAST_DURATION_MS);
    const current = toasts.peek();
    const existing = current.find((toast) => toast.key === key);
    const toast: Toast = {
      id: existing?.id ?? nextId++,
      key,
      message,
      tone,
      action,
      sticky: duration <= 0,
    };
    // A background toast goes under what is on screen; replacing a toast keeps its place.
    const under = options.background === true && !existing && current.length > 0;
    let next = existing
      ? current.map((other) => (other === existing ? toast : other))
      : under
        ? [toast, ...current]
        : [...current, toast];
    while (next.length > MAX_TOASTS) {
      const victim = next.find((other) => !other.sticky && other.id !== toast.id) ?? next[0]!;
      stopTimer(victim.id);
      next = next.filter((other) => other !== victim);
    }
    toasts.value = next;
    startTimer(toast.id, duration, under);
    startWaiting();
    return toast.id;
  }

  return {
    toasts,
    show,
    dismiss,
    runAction(id) {
      const toast = toasts.peek().find((candidate) => candidate.id === id);
      dismiss(id);
      toast?.action?.run();
    },
    pause(id) {
      const timer = timers.get(id);
      if (!timer || timer.paused) return;
      clock.clearTimeout(timer.handle);
      timer.paused = true;
      timer.remaining = Math.max(0, timer.remaining - (clock.now() - timer.startedAt));
    },
    resume(id) {
      const timer = timers.get(id);
      if (!timer || !timer.paused || timer.waiting) return;
      // Never vanish the instant the pointer leaves.
      timer.remaining = Math.max(timer.remaining, 1000);
      arm(id, timer);
    },
    clear() {
      for (const id of [...timers.keys()]) stopTimer(id);
      toasts.value = [];
    },
  };
}

/** The app's toast queue. */
export const toasts: ToastQueue = createToastQueue();
