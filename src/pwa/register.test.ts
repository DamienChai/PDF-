import { describe, expect, it, vi } from 'vitest';
import { SKIP_WAITING } from './protocol';
import {
  manageServiceWorker,
  registerServiceWorker,
  type ServiceWorkerEnvironment,
  type ServiceWorkerHooks,
} from './register';
import { settle } from './testing';

class FakeWorker extends EventTarget {
  state: ServiceWorkerState;
  messages: unknown[] = [];
  onMessage: ((message: unknown) => void) | undefined;
  constructor(state: ServiceWorkerState) {
    super();
    this.state = state;
  }
  postMessage(message: unknown): void {
    this.messages.push(message);
    this.onMessage?.(message);
  }
  become(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  update = vi.fn(async () => undefined);
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null;
  registration = new FakeRegistration();
  register = vi.fn(async (_url: string, _options?: RegistrationOptions) => this.registration);
}

/** A simulated browser: one page, one service worker registration. */
function setup(flag: boolean | null = false) {
  const container = new FakeContainer();
  const { registration } = container;
  const flags = new Map<string, boolean>();
  const visibleCallbacks: (() => void)[] = [];
  const timers: (() => void)[] = [];
  const state = { now: 0, reloads: 0, storage: flag };
  const env: ServiceWorkerEnvironment = {
    container: container as unknown as ServiceWorkerEnvironment['container'],
    scriptUrl: 'https://user.github.io/PDF-/sw.js',
    scope: 'https://user.github.io/PDF-/',
    reload: () => {
      state.reloads++;
    },
    onVisible: (callback) => visibleCallbacks.push(callback),
    readFlag: (key) => (state.storage === null ? null : (flags.get(key) ?? state.storage)),
    writeFlag: (key) => {
      if (state.storage !== null) flags.set(key, true);
    },
    now: () => state.now,
    setTimeout: (callback) => timers.push(callback),
  };

  const refreshes: (() => Promise<void>)[] = [];
  const hooks = {
    onNeedRefresh: vi.fn((apply: () => Promise<void>) => {
      refreshes.push(apply);
    }),
    onOfflineReady: vi.fn(),
  } satisfies ServiceWorkerHooks;

  /** The browser found a (new) worker script and starts installing it. */
  const beginInstall = (): FakeWorker => {
    const worker = new FakeWorker('installing');
    registration.installing = worker;
    registration.dispatchEvent(new Event('updatefound'));
    return worker;
  };
  const finishInstall = (worker: FakeWorker): void => {
    registration.installing = null;
    registration.waiting = worker;
    worker.become('installed');
  };
  /** Activation; with `claim` the worker takes control of the page (clients.claim / takeover). */
  const activate = (worker: FakeWorker, claim: boolean): void => {
    registration.waiting = null;
    registration.active = worker;
    worker.become('activating');
    worker.become('activated');
    if (claim) {
      container.controller = worker;
      container.dispatchEvent(new Event('controllerchange'));
    }
  };
  /** A page that was loaded under an existing, active worker. */
  const existingInstallation = (): FakeWorker => {
    const worker = new FakeWorker('activated');
    registration.active = worker;
    container.controller = worker;
    return worker;
  };
  const becomeVisible = (): void => visibleCallbacks.forEach((callback) => callback());

  return {
    container,
    registration,
    env,
    hooks,
    refreshes,
    state,
    timers,
    beginInstall,
    finishInstall,
    activate,
    existingInstallation,
    becomeVisible,
    start: () => manageServiceWorker(env, hooks),
  };
}

describe('registration', () => {
  it('registers the worker for the app scope and bypasses the HTTP cache for it', async () => {
    const t = setup();
    await t.start();
    expect(t.container.register).toHaveBeenCalledWith('https://user.github.io/PDF-/sw.js', {
      scope: 'https://user.github.io/PDF-/',
      updateViaCache: 'none',
    });
  });

  it('is a no-op in development and outside a browser', () => {
    // Vitest runs in development mode without a navigator.serviceWorker.
    expect(import.meta.env.PROD).toBe(false);
    expect(() => registerServiceWorker({ onNeedRefresh: () => undefined })).not.toThrow();
  });
});

describe('first installation', () => {
  it('announces offline readiness once the worker is active, and no update', async () => {
    const t = setup();
    await t.start();
    const worker = t.beginInstall();
    t.finishInstall(worker);
    expect(t.hooks.onOfflineReady).not.toHaveBeenCalled();
    t.activate(worker, true);
    expect(t.hooks.onOfflineReady).toHaveBeenCalledOnce();
    expect(t.hooks.onNeedRefresh).not.toHaveBeenCalled();
    expect(t.state.reloads).toBe(0);
  });

  it('also sees a worker that was already installing when register() resolved', async () => {
    const t = setup();
    const worker = new FakeWorker('installing');
    t.registration.installing = worker;
    await t.start();
    t.finishInstall(worker);
    t.activate(worker, true);
    expect(t.hooks.onOfflineReady).toHaveBeenCalledOnce();
  });

  it('announces offline readiness only once per installation', async () => {
    const first = setup();
    await first.start();
    const worker = first.beginInstall();
    first.finishInstall(worker);
    first.activate(worker, true);
    expect(first.hooks.onOfflineReady).toHaveBeenCalledOnce();

    // Next visit: the flag is stored.
    const second = setup(true);
    second.existingInstallation();
    await second.start();
    expect(second.hooks.onOfflineReady).not.toHaveBeenCalled();
  });

  it('catches up if the installation finished while nobody was listening', async () => {
    const t = setup(false);
    t.existingInstallation();
    await t.start();
    expect(t.hooks.onOfflineReady).toHaveBeenCalledOnce();
  });

  it('without storage, announces only an installation it witnessed', async () => {
    const returning = setup(null);
    returning.existingInstallation();
    await returning.start();
    expect(returning.hooks.onOfflineReady).not.toHaveBeenCalled();

    const fresh = setup(null);
    await fresh.start();
    const worker = fresh.beginInstall();
    fresh.finishInstall(worker);
    fresh.activate(worker, true);
    expect(fresh.hooks.onOfflineReady).toHaveBeenCalledOnce();
  });
});

describe('updates', () => {
  it('asks before activating a new version and never reloads on its own', async () => {
    const t = setup(true);
    t.existingInstallation();
    await t.start();
    const update = t.beginInstall();
    expect(t.hooks.onNeedRefresh).not.toHaveBeenCalled();
    t.finishInstall(update);
    expect(t.hooks.onNeedRefresh).toHaveBeenCalledOnce();
    expect(update.messages).toEqual([]);
    expect(t.state.reloads).toBe(0);
    expect(t.hooks.onOfflineReady).not.toHaveBeenCalled();
  });

  it('apply() activates the waiting worker and reloads once it controls the page', async () => {
    const t = setup(true);
    t.existingInstallation();
    await t.start();
    const update = t.beginInstall();
    t.finishInstall(update);

    const applied = t.refreshes[0]!();
    await settle();
    expect(update.messages).toEqual([{ type: SKIP_WAITING }]);
    expect(t.state.reloads).toBe(0);

    t.activate(update, true);
    await applied;
    expect(t.state.reloads).toBe(1);
    // The takeover this page asked for is not reported as yet another update.
    expect(t.hooks.onNeedRefresh).toHaveBeenCalledOnce();
  });

  it('reloads only once however often apply() is called', async () => {
    const t = setup(true);
    t.existingInstallation();
    await t.start();
    const update = t.beginInstall();
    t.finishInstall(update);
    const first = t.refreshes[0]!();
    const second = t.refreshes[0]!();
    await settle();
    t.activate(update, true);
    await Promise.all([first, second]);
    await t.refreshes[0]!();
    expect(t.state.reloads).toBe(1);
  });

  it('announces an update once, even if the worker is seen both as installing and via updatefound', async () => {
    const t = setup(true);
    t.existingInstallation();
    // The browser found the update while handling register() …
    const update = new FakeWorker('installing');
    t.registration.installing = update;
    await t.start();
    // … and reports it through the event as well.
    t.registration.dispatchEvent(new Event('updatefound'));
    t.finishInstall(update);
    expect(t.hooks.onNeedRefresh).toHaveBeenCalledOnce();
  });

  it('announces a version that was already waiting when the page loaded', async () => {
    const t = setup(true);
    t.existingInstallation();
    t.registration.waiting = new FakeWorker('installed');
    await t.start();
    expect(t.hooks.onNeedRefresh).toHaveBeenCalledOnce();
  });

  it('works for a page that is not controlled (hard reload) while a version waits', async () => {
    const t = setup(true);
    t.registration.active = new FakeWorker('activated');
    const waiting = new FakeWorker('installed');
    t.registration.waiting = waiting;
    await t.start();
    expect(t.hooks.onNeedRefresh).toHaveBeenCalledOnce();
    const applied = t.refreshes[0]!();
    await settle();
    t.activate(waiting, true);
    await applied;
    expect(t.state.reloads).toBe(1);
  });

  it('reloads anyway if the new worker never takes over', async () => {
    const t = setup(true);
    t.existingInstallation();
    await t.start();
    const update = t.beginInstall();
    t.finishInstall(update);
    const applied = t.refreshes[0]!();
    await settle();
    expect(t.timers).toHaveLength(1);
    t.timers[0]!();
    await applied;
    expect(t.state.reloads).toBe(1);
  });

  it('just reloads when another tab has already activated the update', async () => {
    const t = setup(true);
    t.existingInstallation();
    await t.start();
    const update = t.beginInstall();
    t.finishInstall(update);
    // The other tab accepted: the worker takes over this page as well.
    t.activate(update, true);
    expect(t.hooks.onNeedRefresh).toHaveBeenCalledTimes(2);
    expect(t.state.reloads).toBe(0);
    await t.refreshes[1]!();
    expect(t.state.reloads).toBe(1);
    // The first callback still works: nothing is waiting any more, so it reloads as well (once).
    await t.refreshes[0]!();
    expect(t.state.reloads).toBe(1);
  });

  it('handles an update that arrives long after a first installation in the same session', async () => {
    const t = setup();
    await t.start();
    const first = t.beginInstall();
    t.finishInstall(first);
    t.activate(first, true);
    expect(t.hooks.onNeedRefresh).not.toHaveBeenCalled();

    const update = t.beginInstall();
    t.finishInstall(update);
    expect(t.hooks.onNeedRefresh).toHaveBeenCalledOnce();
    const applied = t.refreshes[0]!();
    await settle();
    t.activate(update, true);
    await applied;
    expect(t.state.reloads).toBe(1);
    expect(t.hooks.onOfflineReady).toHaveBeenCalledOnce();
  });

  it('ignores an update that fails to install', async () => {
    const t = setup(true);
    t.existingInstallation();
    await t.start();
    const update = t.beginInstall();
    t.registration.installing = null;
    update.become('redundant');
    expect(t.hooks.onNeedRefresh).not.toHaveBeenCalled();
  });
});

describe('update checks', () => {
  it('looks for a new version when the page becomes visible, at most once an hour', async () => {
    const t = setup(true);
    t.existingInstallation();
    await t.start();
    t.becomeVisible();
    expect(t.registration.update).not.toHaveBeenCalled();

    t.state.now = 61 * 60 * 1000;
    t.becomeVisible();
    t.becomeVisible();
    expect(t.registration.update).toHaveBeenCalledOnce();

    t.state.now += 30 * 60 * 1000;
    t.becomeVisible();
    expect(t.registration.update).toHaveBeenCalledOnce();
    t.state.now += 31 * 60 * 1000;
    t.becomeVisible();
    expect(t.registration.update).toHaveBeenCalledTimes(2);
  });

  it('shrugs off failed checks (offline)', async () => {
    const t = setup(true);
    t.existingInstallation();
    await t.start();
    t.registration.update.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    t.state.now = 2 * 60 * 60 * 1000;
    expect(() => t.becomeVisible()).not.toThrow();
    await settle();
  });
});
