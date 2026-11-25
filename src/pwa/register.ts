/** Service worker registration and update flow. */
import { SKIP_WAITING, type SkipWaitingMessage } from './protocol';

export interface ServiceWorkerHooks {
  /** A new version is waiting. Call `apply()` to activate it and reload the page. */
  onNeedRefresh?: (apply: () => Promise<void>) => void;
  /** Everything is cached; the app now works offline. Fired once per installation. */
  onOfflineReady?: () => void;
}

/** Remembers that `onOfflineReady` has been announced. */
const OFFLINE_READY_KEY = 'pdfkey:offline-ready';
/** How often a long-running window looks for a new version when it becomes visible again. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** If a new worker has not taken over by then, reload anyway instead of leaving the UI stuck. */
const ACTIVATION_TIMEOUT_MS = 10_000;

type ContainerLike = Pick<
  ServiceWorkerContainer,
  'register' | 'controller' | 'addEventListener' | 'removeEventListener'
>;

/** Everything the update flow needs from the browser; replaced by fakes in tests. */
export interface ServiceWorkerEnvironment {
  container: ContainerLike;
  scriptUrl: string;
  scope: string;
  reload(): void;
  /** Calls back whenever the page becomes visible again. */
  onVisible(callback: () => void): void;
  /** `null` when storage is unavailable (private mode, blocked cookies). */
  readFlag(key: string): boolean | null;
  writeFlag(key: string): void;
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
}

/**
 * Registers the worker and wires the "prompt" update strategy: a new version installs in the
 * background and then waits; it only takes over when the user agrees, never in the middle of work.
 */
export async function manageServiceWorker(
  env: ServiceWorkerEnvironment,
  hooks: ServiceWorkerHooks = {},
): Promise<void> {
  const { container } = env;
  /** This page is activating the waiting version itself and will reload. */
  let applying = false;
  let reloading = false;
  /** A worker (of whatever version) controls this page. */
  let controlled = container.controller !== null;
  let offlineReadyAnnounced = false;

  const registration = await container.register(env.scriptUrl, {
    scope: env.scope,
    // GitHub Pages serves everything with max-age=600; the worker script must bypass that.
    updateViaCache: 'none',
  });

  const reloadOnce = (): void => {
    if (reloading) return;
    reloading = true;
    env.reload();
  };

  const apply = async (): Promise<void> => {
    const waiting = registration.waiting;
    // Nothing waiting any more: another tab already activated the new version.
    if (!waiting) return reloadOnce();
    applying = true;
    await new Promise<void>((resolve) => {
      container.addEventListener('controllerchange', () => resolve(), { once: true });
      env.setTimeout(resolve, ACTIVATION_TIMEOUT_MS);
      waiting.postMessage({ type: SKIP_WAITING } satisfies SkipWaitingMessage);
    });
    reloadOnce();
  };

  const announced = new WeakSet<ServiceWorker>();
  const announceUpdate = (): void => {
    const { waiting } = registration;
    // A waiting worker next to an active one is an update. (A waiting worker alone is the very
    // first installation, about to activate by itself.)
    if (!waiting || !registration.active || announced.has(waiting)) return;
    announced.add(waiting);
    hooks.onNeedRefresh?.(apply);
  };

  const announceOfflineReady = (witnessedInstall: boolean): void => {
    if (offlineReadyAnnounced) return;
    const stored = env.readFlag(OFFLINE_READY_KEY);
    if (stored === true) return;
    // Without storage there is no telling whether this was announced in an earlier session;
    // then only speak up when the installation happened right now.
    if (stored === null && !witnessedInstall) return;
    offlineReadyAnnounced = true;
    env.writeFlag(OFFLINE_READY_KEY);
    hooks.onOfflineReady?.();
  };

  // A worker can show up twice: as `installing` when register() resolves and again through
  // `updatefound`.
  const tracked = new WeakSet<ServiceWorker>();
  const track = (worker: ServiceWorker | null): void => {
    if (!worker || tracked.has(worker)) return;
    tracked.add(worker);
    // Decided when the worker shows up: is it replacing an older version?
    const isUpdate = registration.active !== null && registration.active !== worker;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && isUpdate) announceUpdate();
      if (worker.state === 'activated' && !isUpdate) announceOfflineReady(true);
    });
  };

  container.addEventListener('controllerchange', () => {
    const wasControlled = controlled;
    controlled = true;
    // A first installation claiming the page changes nothing underneath it, and a takeover this
    // page asked for is followed by its own reload.
    if (!wasControlled || applying || reloading) return;
    // Another tab activated the update. This page now runs old code on top of the new caches,
    // so it should reload too, when the user is ready.
    hooks.onNeedRefresh?.(async () => reloadOnce());
  });

  registration.addEventListener('updatefound', () => track(registration.installing));
  track(registration.installing);
  // A version that finished installing during an earlier visit is still waiting.
  announceUpdate();
  if (registration.active) announceOfflineReady(false);

  let lastCheck = env.now();
  env.onVisible(() => {
    if (env.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
    lastCheck = env.now();
    // Fails while offline; the next check will do.
    registration.update().catch(() => undefined);
  });
}

function browserEnvironment(): ServiceWorkerEnvironment {
  return {
    container: navigator.serviceWorker,
    // Relative to the page, like every other URL of the app (it may live in any sub-path).
    scriptUrl: new URL('sw.js', document.baseURI).href,
    scope: new URL('./', document.baseURI).href,
    reload: () => window.location.reload(),
    onVisible: (callback) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') callback();
      });
    },
    readFlag: (key) => {
      try {
        return window.localStorage.getItem(key) === '1';
      } catch {
        return null;
      }
    },
    writeFlag: (key) => {
      try {
        window.localStorage.setItem(key, '1');
      } catch {
        // Not remembered; see announceOfflineReady.
      }
    },
    now: () => Date.now(),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  };
}

/** No-op in development and wherever service workers are unavailable. */
export function registerServiceWorker(hooks?: ServiceWorkerHooks): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const start = (): void => {
    // Registration fails in private windows of some browsers and on file:// — the app simply
    // runs without offline support then.
    manageServiceWorker(browserEnvironment(), hooks).catch(() => undefined);
  };
  // After `load`, so that precaching does not compete with the first render.
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
