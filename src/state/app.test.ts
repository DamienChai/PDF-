import { signal } from '@preact/signals';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceWorkerHooks } from '../pwa/register';
import { createDemoFile } from '../../tests/support/fake-engine';
import { createHarness } from '../../tests/support/jobs-harness';
import {
  closeOverlay,
  createAppStarter,
  detailsEntry,
  dragActive,
  mode,
  openDetails,
  openSettings,
  overlay,
  pickFiles,
  setMode,
  start,
  type AppDependencies,
} from './app';
import type { EngineStatus } from './engine';
import { DEFAULT_MODE, modeFromUrl } from './mode';
import { createOverlayController } from './overlay';

function setup(overrides: Partial<AppDependencies> = {}) {
  const harness = createHarness();
  const engineStatus = signal<EngineStatus>('idle');
  const engine = { status: engineStatus, preload: vi.fn(), retry: vi.fn(async () => null) };
  const overlayController = createOverlayController(null);
  const applyEffects = vi.fn(() => () => undefined);
  const attachIntake = vi.fn(() => () => undefined);
  const chosenMode = vi.fn();
  let hooks: ServiceWorkerHooks = {};
  let incoming: Parameters<AppDependencies['onIncomingFiles']>[0] = () => undefined;
  let launch: Parameters<AppDependencies['onLaunchUrl']>[0] = () => undefined;
  const deps: AppDependencies = {
    settings: { applyEffects },
    jobs: harness.jobs,
    toasts: harness.toasts,
    engine,
    overlay: overlayController,
    intake: { attach: attachIntake },
    setMode: chosenMode,
    registerServiceWorker: (given) => {
      hooks = given;
    },
    onIncomingFiles: (handler) => {
      incoming = handler;
    },
    onLaunchUrl: (handler) => {
      launch = handler;
    },
    ...overrides,
  };
  const startApp = createAppStarter(deps);
  return {
    ...harness,
    startApp,
    engine,
    engineStatus,
    overlayController,
    applyEffects,
    attachIntake,
    chosenMode,
    hooks: () => hooks,
    /** Number of inspections the engine was asked for. */
    inspections: () => harness.engine.calls.inspect.length,
    incoming: (files: File[]) => incoming(files, 'share-target'),
    launch: (url: string) => launch(new URL(url)),
  };
}

describe('start', () => {
  it('wires everything, once', () => {
    const app = setup();
    app.startApp();
    app.startApp();
    expect(app.applyEffects).toHaveBeenCalledTimes(1);
    expect(app.attachIntake).toHaveBeenCalledTimes(1);
    expect(app.engine.preload).toHaveBeenCalledTimes(1);
    expect(app.hooks().onNeedRefresh).toBeTypeOf('function');
    expect(app.hooks().onOfflineReady).toBeTypeOf('function');
  });

  it('carries on when a platform feature is missing or throws', () => {
    const failing = (): never => {
      throw new Error('not supported here');
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = setup({
        settings: { applyEffects: failing },
        registerServiceWorker: failing,
        onIncomingFiles: failing,
        intake: { attach: failing },
        startDevTools: failing,
      });
      expect(() => app.startApp()).not.toThrow();
      // What can work, works.
      expect(app.engine.preload).toHaveBeenCalledTimes(1);
      app.launch('https://app.example/?mode=lock');
      expect(app.chosenMode).toHaveBeenCalledWith('lock');
      expect(errors).toHaveBeenCalledTimes(5);
    } finally {
      errors.mockRestore();
    }
  });

  it('runs the development extras when there are any', () => {
    const startDevTools = vi.fn();
    setup({ startDevTools }).startApp();
    expect(startDevTools).toHaveBeenCalledTimes(1);
  });
});

describe('service worker toasts', () => {
  it('offers to refresh when an update is waiting, and applies it on request', () => {
    const app = setup();
    app.startApp();
    const apply = vi.fn(async () => undefined);
    app.hooks().onNeedRefresh!(apply);
    const [toast] = app.toasts.toasts.value;
    expect(toast).toMatchObject({
      message: { key: 'toast.update' },
      sticky: true,
      action: { label: { key: 'toast.update.action' } },
    });
    expect(apply).not.toHaveBeenCalled();
    app.toasts.runAction(toast!.id);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(app.toasts.toasts.value).toEqual([]);
  });

  it('shows one update toast when the update is announced twice, using the newer action', () => {
    const app = setup();
    app.startApp();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    app.hooks().onNeedRefresh!(first);
    app.hooks().onNeedRefresh!(second);
    expect(app.toasts.toasts.value).toHaveLength(1);
    app.toasts.runAction(app.toasts.toasts.value[0]!.id);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('survives an update that fails to apply', async () => {
    const app = setup();
    app.startApp();
    app.hooks().onNeedRefresh!(async () => {
      throw new Error('worker vanished');
    });
    app.toasts.runAction(app.toasts.toasts.value[0]!.id);
    await Promise.resolve();
    expect(app.toasts.toasts.value).toEqual([]);
  });

  it('announces offline readiness once', () => {
    const app = setup();
    app.startApp();
    app.hooks().onOfflineReady!();
    app.hooks().onOfflineReady!();
    expect(app.toasts.toasts.value).toMatchObject([
      { message: { key: 'toast.offlineReady' }, tone: 'success', sticky: false },
    ]);
  });
});

describe('incoming files and launches', () => {
  it('adds files that were shared to or opened with the app, and shows the list', async () => {
    const app = setup();
    app.startApp();
    app.overlayController.openSettings();
    app.incoming([createDemoFile('needs-password.pdf')]);
    expect(app.overlayController.overlay.value).toBeNull();
    await app.jobs.settled();
    expect(app.jobs.entries.value).toMatchObject([
      { name: 'needs-password.pdf', source: 'share-target' },
    ]);
  });

  it('follows app shortcuts into a mode and ignores other addresses', () => {
    const app = setup();
    app.startApp();
    app.launch('https://app.example/pdf/?mode=lock');
    app.launch('https://app.example/pdf/');
    app.launch('https://app.example/pdf/?mode=destroy');
    app.launch('https://app.example/pdf/?mode=unlock');
    expect(app.chosenMode.mock.calls).toEqual([['lock'], ['unlock']]);
  });
});

describe('engine availability', () => {
  it('reports an engine that cannot be loaded and offers to try again', () => {
    const app = setup();
    app.startApp();
    expect(app.toasts.toasts.value).toEqual([]);
    app.engineStatus.value = 'loading';
    app.engineStatus.value = 'unavailable';
    const [toast] = app.toasts.toasts.value;
    expect(toast).toMatchObject({
      message: { key: 'toast.engineUnavailable' },
      tone: 'error',
      sticky: true,
      action: { label: { key: 'toast.retry' } },
    });
    app.toasts.runAction(toast!.id);
    expect(app.engine.retry).toHaveBeenCalledTimes(1);
  });

  it('shows the toast again when the retry fails too', () => {
    const app = setup();
    app.startApp();
    app.engineStatus.value = 'unavailable';
    app.toasts.runAction(app.toasts.toasts.value[0]!.id);
    app.engineStatus.value = 'loading';
    app.engineStatus.value = 'unavailable';
    expect(app.toasts.toasts.value).toHaveLength(1);
  });

  it('takes the toast away and reads the waiting files once the engine works', async () => {
    const harness = createHarness({ engine: { unavailable: true } });
    const app = setup({ jobs: harness.jobs, toasts: harness.toasts });
    app.startApp();
    await harness.add('plain.pdf');
    expect(harness.states()).toEqual(['error']);

    app.engineStatus.value = 'unavailable';
    harness.engine.setUnavailable(false);
    app.engineStatus.value = 'loading';
    app.engineStatus.value = 'ready';
    expect(harness.toasts.toasts.value).toEqual([]);
    await harness.jobs.settled();
    expect(harness.states()).toEqual(['not-encrypted']);
  });

  it('does not touch the files on an ordinary first load', async () => {
    const app = setup();
    app.startApp();
    await app.add('damaged.pdf');
    const before = app.inspections();
    app.engineStatus.value = 'loading';
    app.engineStatus.value = 'ready';
    await app.jobs.settled();
    expect(app.inspections()).toBe(before);
  });
});

describe('details sheet and file list', () => {
  it('closes the details of a file that is removed', async () => {
    const app = setup();
    app.startApp();
    const [kept, removed] = await app.add('plain.pdf', 'aes128.pdf');
    app.overlayController.openDetails(removed!.id);
    app.jobs.remove(kept!.id);
    expect(app.overlayController.overlay.value).toEqual({ kind: 'details', entryId: removed!.id });
    app.jobs.remove(removed!.id);
    expect(app.overlayController.overlay.value).toBeNull();
  });

  it('closes the details when the list is cleared, but not the settings', async () => {
    const app = setup();
    app.startApp();
    const [entry] = await app.add('plain.pdf');
    app.overlayController.openDetails(entry!.id);
    app.jobs.clear();
    expect(app.overlayController.overlay.value).toBeNull();
    app.overlayController.openSettings();
    await app.add('plain.pdf');
    app.jobs.clear();
    expect(app.overlayController.overlay.value).toEqual({ kind: 'settings' });
  });
});

describe('mode', () => {
  it('reads the mode of an app shortcut from an address', () => {
    expect(modeFromUrl('https://x.test/app/?mode=lock')).toBe('lock');
    expect(modeFromUrl(new URL('https://x.test/?a=1&mode=unlock#top'))).toBe('unlock');
    expect(modeFromUrl('./?mode=lock')).toBe('lock');
    expect(modeFromUrl('https://x.test/?mode=LOCK')).toBeNull();
    expect(modeFromUrl('https://x.test/')).toBeNull();
    expect(modeFromUrl('')).toBeNull();
    expect(modeFromUrl(null)).toBeNull();
    expect(modeFromUrl('http://[broken')).toBeNull();
  });

  it('starts in unlock mode and can be switched', () => {
    expect(DEFAULT_MODE).toBe('unlock');
    expect(mode.value).toBe('unlock');
    setMode('lock');
    expect(mode.value).toBe('lock');
    setMode('unlock');
  });
});

describe('the app instances outside a browser', () => {
  it('can be imported, started and used without a window', () => {
    expect(() => start()).not.toThrow();
    expect(() => start()).not.toThrow();
    expect(dragActive.value).toBe(false);
    expect(() => pickFiles()).not.toThrow();
    openSettings();
    expect(overlay.value).toEqual({ kind: 'settings' });
    expect(detailsEntry.value).toBeNull();
    closeOverlay();
    expect(overlay.value).toBeNull();
    // Details of a file that is not in the list close by themselves once the app has started.
    openDetails('nope');
    expect(overlay.value).toBeNull();
    expect(detailsEntry.value).toBeNull();
  });
});
