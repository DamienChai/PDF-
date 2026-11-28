/**
 * The shell of the app: mode, open sheet, drop overlay, and `start()`, which wires the state
 * modules to the platform exactly once.
 */
import { computed, effect, signal, untracked, type ReadonlySignal } from '@preact/signals';
import {
  onIncomingFiles,
  onLaunchUrl,
  onShareProblem,
  type IncomingSource,
  type ShareProblem,
} from '../pwa/incoming';
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
  jobs: Pick<JobsController, 'entries' | 'addFiles' | 'retryInspections' | 'unsavedWork'>;
  toasts: ToastQueue;
  engine: Pick<EngineState, 'status' | 'preload' | 'retry'>;
  overlay: OverlayController;
  intake: Pick<Intake, 'attach'>;
  setMode(mode: Mode): void;
  registerServiceWorker(hooks: ServiceWorkerHooks): void;
  onIncomingFiles(handler: (files: File[], source: IncomingSource) => void): unknown;
  onLaunchUrl(handler: (url: URL) => void): unknown;
  onShareProblem(handler: (problem: ShareProblem) => void): unknown;
  /** Extras of a development build. */
  startDevTools?: (() => void) | undefined;
}

/** Toast keys: one toast per subject, however often it is announced. */
const UPDATE_TOAST = 'app-update';
const OFFLINE_TOAST = 'offline-ready';
const ENGINE_TOAST = 'engine-unavailable';
const SHARE_TOAST = 'share-lost';

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

  /**
   * A new version is offered only while reloading costs nothing: nothing is being processed and
   * every result is saved. Until then the offer waits, and it is withdrawn when work begins
   * while it is on screen. Dismissing the toast declines the offer.
   */
  function offerUpdates(): ServiceWorkerHooks {
    type Apply = () => Promise<void>;
    const mayReload = (): boolean => !deps.jobs.unsavedWork.peek();
    /** Applies the update that waits for a good moment or for the user's answer. */
    const offer = signal<Apply | null>(null);
    /** The toast on screen and the update it stands for. */
    let shown: { id: number; apply: Apply } | null = null;

    effect(() => {
      const apply = offer.value;
      const safe = !deps.jobs.unsavedWork.value;
      const onScreen = deps.toasts.toasts.value.some((toast) => toast.id === shown?.id);
      untracked(() => {
        if (shown && !onScreen) {
          // Dismissed by the user, or its action is about to run.
          shown = null;
          offer.value = null;
        } else if (shown && (!apply || !safe)) {
          const { id } = shown;
          shown = null;
          deps.toasts.dismiss(id);
        } else if (apply && safe && shown?.apply !== apply) {
          const id = deps.toasts.show(
            { key: 'toast.update' },
            {
              key: UPDATE_TOAST,
              duration: 0,
              action: {
                label: { key: 'toast.update.action' },
                run: () => {
                  if (mayReload()) void apply().catch(() => undefined);
                  // Work began in the very moment of the tap: the offer waits again.
                  else offer.value = apply;
                },
              },
            },
          );
          shown = { id, apply };
        }
      });
    });

    return {
      mayReload,
      onNeedRefresh: (apply) => {
        offer.value = apply;
      },
    };
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
        ...offerUpdates(),
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
      deps.onShareProblem(({ received, lost }) => {
        deps.overlay.close();
        deps.toasts.show(
          received > 0 && lost !== null
            ? { key: 'toast.shareLostCount', params: { count: lost } }
            : { key: 'toast.shareLost' },
          { key: SHARE_TOAST, tone: 'error' },
        );
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
  notify: (message, tone) => void toasts.show(message, { tone }),
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
  onShareProblem,
  startDevTools,
});
