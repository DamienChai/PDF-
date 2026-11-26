/**
 * The shell of the app: mode, open sheet, drop overlay, and `start()`, which wires the state
 * modules to the platform exactly once.
 */
import { computed, effect, untracked, type ReadonlySignal } from '@preact/signals';
import { onIncomingFiles, onLaunchUrl, type IncomingSource } from '../pwa/incoming';
import { registerServiceWorker, type ServiceWorkerHooks } from '../pwa/register';
import { engineState, isFakeEngineRequested, type EngineState } from './engine';
import { createIntake, openPdfPicker, type Intake } from './intake';
import { jobs, type Entry, type JobsController } from './jobs';
import { modeFromUrl, setMode, type Mode } from './mode';
import { createOverlayController, type Overlay, type OverlayController } from './overlay';
import { settingsStore, type SettingsStore } from './settings';
import { toasts, type ToastQueue } from './toasts';

export { mode, setMode, type Mode } from './mode';
export type { Overlay } from './overlay';

/** Everything `start()` connects; replaced by fakes in tests. */
export interface AppDependencies {
  settings: Pick<SettingsStore, 'applyEffects'>;
  jobs: Pick<JobsController, 'entries' | 'addFiles' | 'retryInspections'>;
  toasts: ToastQueue;
  engine: Pick<EngineState, 'status' | 'preload' | 'retry'>;
  overlay: OverlayController;
  intake: Pick<Intake, 'attach'>;
  setMode(mode: Mode): void;
  registerServiceWorker(hooks: ServiceWorkerHooks): void;
  onIncomingFiles(handler: (files: File[], source: IncomingSource) => void): unknown;
  onLaunchUrl(handler: (url: URL) => void): unknown;
  /** Extras of a development build. */
  startDevTools?: (() => void) | undefined;
}

/** Toast keys: one toast per subject, however often it is announced. */
const UPDATE_TOAST = 'app-update';
const OFFLINE_TOAST = 'offline-ready';
const ENGINE_TOAST = 'engine-unavailable';

/**
 * Returns the app's `start` function. Every step is independent: a platform feature that is
 * missing or throws costs that feature, not the app. Calling it again does nothing.
 */
export function createAppStarter(deps: AppDependencies): () => void {
  let started = false;

  function step(run: () => void): void {
    try {
      run();
    } catch (error) {
      console.error(error);
    }
  }

  function watchEngine(): void {
    let announced: number | null = null;
    effect(() => {
      const status = deps.engine.status.value;
      untracked(() => {
        if (status === 'unavailable') {
          announced = deps.toasts.show(
            { key: 'toast.engineUnavailable' },
            {
              key: ENGINE_TOAST,
              tone: 'error',
              duration: 0,
              action: { label: { key: 'toast.retry' }, run: () => void deps.engine.retry() },
            },
          );
        } else if (status === 'ready' && announced !== null) {
          deps.toasts.dismiss(announced);
          announced = null;
          // Files that were added while the engine was down can be read now.
          deps.jobs.retryInspections('engine-unavailable');
        }
      });
    });
  }

  /** The details sheet or menu of a file that is no longer in the list has nothing to show. */
  function closeOrphanedDetails(): void {
    effect(() => {
      const open = deps.overlay.overlay.value;
      if (open?.kind !== 'details' && open?.kind !== 'menu') return;
      const listed = deps.jobs.entries.value.some((entry) => entry.id === open.entryId);
      if (!listed) untracked(() => deps.overlay.close());
    });
  }

  return function start(): void {
    if (started) return;
    started = true;

    step(() => void deps.settings.applyEffects());
    step(() => void deps.overlay.attach());
    step(() => void deps.intake.attach());
    step(closeOrphanedDetails);
    step(() =>
      deps.registerServiceWorker({
        onNeedRefresh: (apply) => {
          deps.toasts.show(
            { key: 'toast.update' },
            {
              key: UPDATE_TOAST,
              duration: 0,
              action: {
                label: { key: 'toast.update.action' },
                run: () => void apply().catch(() => undefined),
              },
            },
          );
        },
        onOfflineReady: () => {
          deps.toasts.show({ key: 'toast.offlineReady' }, { key: OFFLINE_TOAST, tone: 'success' });
        },
      }),
    );
    step(() =>
      deps.onIncomingFiles((files, source) => {
        // Shared to or opened with the app: the list is what the user wants to see now.
        deps.overlay.close();
        void deps.jobs.addFiles(files, source);
      }),
    );
    step(() =>
      deps.onLaunchUrl((url) => {
        const requested = modeFromUrl(url);
        if (requested) deps.setMode(requested);
      }),
    );
    step(watchEngine);
    step(() => deps.engine.preload());
    step(() => deps.startDevTools?.());
  };
}

// --- The app's instances -------------------------------------------------------------------------

const hasWindow = typeof window !== 'undefined';

const overlayController = createOverlayController(
  hasWindow ? { history: window.history, events: window } : null,
);

const intake = createIntake({
  addFiles: (files, source) => void jobs.addFiles(files, source),
  target: hasWindow ? window : undefined,
  openPicker: typeof document === 'undefined' ? undefined : openPdfPicker,
});

/** The sheet or dialog that is open, if any. */
export const overlay: ReadonlySignal<Overlay | null> = overlayController.overlay;

/** The file whose details are open, if any. */
export const detailsEntry: ReadonlySignal<Entry | null> = computed(() => {
  const open = overlayController.overlay.value;
  if (open?.kind !== 'details') return null;
  return jobs.entries.value.find((entry) => entry.id === open.entryId) ?? null;
});

export function openSettings(): void {
  overlayController.openSettings();
}

export function openDetails(entryId: string): void {
  overlayController.openDetails(entryId);
}

/** Opens the action menu (details, remove …) of a file. */
export function openMenu(entryId: string): void {
  overlayController.openMenu(entryId);
}

/** The file whose action menu is open, if any. */
export const menuEntry: ReadonlySignal<Entry | null> = computed(() => {
  const open = overlayController.overlay.value;
  if (open?.kind !== 'menu') return null;
  return jobs.entries.value.find((entry) => entry.id === open.entryId) ?? null;
});

/** Closes the open sheet or dialog (close button, scrim, Escape). The back gesture does it too. */
export function closeOverlay(): void {
  overlayController.close();
}

/** Files are being dragged over the window: show the full-window drop overlay. */
export const dragActive: ReadonlySignal<boolean> = intake.dragActive;

/** Opens the system file picker for PDFs. Call it directly from a click handler. */
export function pickFiles(): void {
  intake.pickFiles();
}

function startDevTools(): void {
  if (import.meta.env.DEV) {
    if (!isFakeEngineRequested()) return;
    void import('./dev').then((dev) => dev.installDevTools(location.search));
  }
}

/**
 * Starts the app: applies the settings to the document, listens for the back gesture, drops and
 * paste, registers the service worker, takes in shared and opened files, follows app shortcuts,
 * and preloads the engine. Call it once from the entry point, before or after the first render.
 */
export const start: () => void = createAppStarter({
  settings: settingsStore,
  jobs,
  toasts,
  engine: engineState,
  overlay: overlayController,
  intake,
  setMode,
  registerServiceWorker,
  onIncomingFiles,
  onLaunchUrl,
  startDevTools,
});
