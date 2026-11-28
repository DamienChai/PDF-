/** "Install app" prompt handling. */
import { signal, type ReadonlySignal, type Signal } from '@preact/signals';

/**
 * - `unavailable`  the browser offers no programmatic install prompt (yet)
 * - `available`    `promptInstall()` will show the native install dialog
 * - `installed`    running as an installed app (standalone display mode) or just installed
 */
export type InstallState = 'unavailable' | 'available' | 'installed';

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

/** Chromium's `beforeinstallprompt` event (not part of the TypeScript DOM library). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface MediaQuery {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
}

/** Everything this module needs from the browser; replaced by fakes in tests. */
export interface InstallEnvironment {
  /** Receives `beforeinstallprompt` and `appinstalled` (the window). */
  events: Pick<EventTarget, 'addEventListener'>;
  matchMedia?: ((query: string) => MediaQuery) | undefined;
  /** iOS Safari's non-standard `navigator.standalone`. */
  iosStandalone?: boolean | undefined;
  /** `document.referrer`: Trusted Web Activities start with an `android-app://` referrer. */
  referrer?: string | undefined;
}

/** Display modes an installed app window can be in; a browser tab is in none of them. */
const APP_DISPLAY_MODES = ['standalone', 'window-controls-overlay', 'minimal-ui'] as const;

export interface InstallController {
  state: ReadonlySignal<InstallState>;
  prompt(): Promise<InstallOutcome>;
  isStandalone(): boolean;
}

export function createInstallController(env: InstallEnvironment | null): InstallController {
  const queries = env?.matchMedia
    ? APP_DISPLAY_MODES.map((mode) => env.matchMedia!(`(display-mode: ${mode})`))
    : [];

  function isStandalone(): boolean {
    if (!env) return false;
    return (
      queries.some((query) => query.matches) ||
      env.iosStandalone === true ||
      (env.referrer ?? '').startsWith('android-app://')
    );
  }

  const state: Signal<InstallState> = signal(isStandalone() ? 'installed' : 'unavailable');
  let deferred: BeforeInstallPromptEvent | null = null;

  if (env) {
    env.events.addEventListener('beforeinstallprompt', (event) => {
      // Keeps the browser's own mini-infobar away; the app offers installation in its own UI.
      event.preventDefault();
      deferred = event as BeforeInstallPromptEvent;
      if (state.value !== 'installed') state.value = 'available';
    });
    env.events.addEventListener('appinstalled', () => {
      deferred = null;
      state.value = 'installed';
    });
    // Desktop browsers move the tab into an app window when the user installs from the address bar.
    for (const query of queries) {
      query.addEventListener?.('change', () => {
        if (isStandalone()) state.value = 'installed';
      });
    }
  }

  async function prompt(): Promise<InstallOutcome> {
    const event = deferred;
    if (!event) return 'unavailable';
    // The event is good for a single prompt; the browser fires a new one when it is ready again.
    deferred = null;
    try {
      await event.prompt();
      const { outcome } = await event.userChoice;
      state.value = outcome === 'accepted' ? 'installed' : 'unavailable';
      return outcome === 'accepted' ? 'accepted' : 'dismissed';
    } catch {
      // No user activation, or the prompt was already used.
      if (state.value === 'available') state.value = 'unavailable';
      return 'unavailable';
    }
  }

  return { state, prompt, isStandalone };
}

function browserEnvironment(): InstallEnvironment | null {
  if (typeof window === 'undefined') return null;
  return {
    events: window,
    matchMedia: typeof window.matchMedia === 'function' ? (q) => window.matchMedia(q) : undefined,
    iosStandalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    referrer: document.referrer,
  };
}

// Created when the module is first imported: `beforeinstallprompt` fires early, possibly before
// the UI has rendered, and must not be missed.
const controller = createInstallController(browserEnvironment());

export const installState: ReadonlySignal<InstallState> = controller.state;

export function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  return controller.prompt();
}

/** True when running as an installed app. */
export function isStandalone(): boolean {
  return controller.isStandalone();
}
