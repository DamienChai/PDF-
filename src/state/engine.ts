/**
 * The app's PDF engine: created on first use, preloaded when the browser is idle, and observable
 * (version for the About section, "could not be loaded" for an error banner).
 *
 * Development builds only: `?fake` in the page address swaps in the scripted engine from
 * tests/support/fake-engine.ts. The branch is guarded by `import.meta.env.DEV`, which the
 * production build replaces by `false`, so neither the code nor the import survives.
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import { createPdfEngine } from '../engine';
import {
  PdfEngineError,
  type CallOptions,
  type EngineInfo,
  type InspectResult,
  type PdfEngine,
  type ProcessCallOptions,
  type ProcessRequest,
  type ProcessResult,
} from '../engine/types';

/**
 * - `idle`         nothing loaded yet
 * - `loading`      the WebAssembly module is being fetched and compiled
 * - `ready`        usable; `info` is set
 * - `unavailable`  loading failed (offline on first use, WebAssembly blocked …); `retry()` may help
 */
export type EngineStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface EngineState {
  readonly status: ReadonlySignal<EngineStatus>;
  /** qpdf version, worker count and mode, once loaded. */
  readonly info: ReadonlySignal<EngineInfo | null>;
  /** Technical detail of the last loading failure. */
  readonly failure: ReadonlySignal<string | null>;
  /**
   * The engine. Calls may be made at any time: the real engine is created by the first one.
   * Do not call `dispose()` on it; use `EngineState.dispose()`.
   */
  readonly engine: PdfEngine;
  /** Loads the engine now. Never rejects: the outcome is in `status`. */
  load(): Promise<EngineInfo | null>;
  /** Loads the engine once the browser has nothing better to do. */
  preload(): void;
  /** Tries again after `unavailable`. */
  retry(): Promise<EngineInfo | null>;
  dispose(): void;
}

export interface EngineStateOptions {
  /** Creates the engine; called once, by the first use. May be asynchronous. */
  create: () => PdfEngine | Promise<PdfEngine>;
  /** Runs a callback when the browser is idle. Default: `requestIdleCallback`, else a timer. */
  whenIdle?: (callback: () => void) => void;
}

const IDLE_TIMEOUT_MS = 2000;
const IDLE_FALLBACK_DELAY_MS = 300;

function defaultWhenIdle(callback: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => callback(), { timeout: IDLE_TIMEOUT_MS });
  } else {
    setTimeout(callback, IDLE_FALLBACK_DELAY_MS);
  }
}

function detailOf(error: unknown): string {
  if (error instanceof PdfEngineError) return error.detail ?? error.code;
  return error instanceof Error ? error.message : String(error);
}

export function createEngineState(options: EngineStateOptions): EngineState {
  const status = signal<EngineStatus>('idle');
  const info = signal<EngineInfo | null>(null);
  const failure = signal<string | null>(null);
  let created: Promise<PdfEngine> | undefined;
  let loading: Promise<EngineInfo | null> | undefined;
  let preloadRequested = false;
  let disposed = false;

  function resolve(): Promise<PdfEngine> {
    if (disposed) {
      return Promise.reject(new PdfEngineError('cancelled', 'the engine was disposed'));
    }
    created ??= Promise.resolve()
      .then(options.create)
      .catch((error: unknown) => {
        // Allow another attempt: a failed dynamic import is not cached by this module.
        created = undefined;
        throw error instanceof PdfEngineError
          ? error
          : new PdfEngineError('engine-unavailable', detailOf(error));
      });
    return created;
  }

  function markUnavailable(error: unknown): void {
    info.value = null;
    failure.value = detailOf(error);
    status.value = 'unavailable';
  }

  function load(): Promise<EngineInfo | null> {
    loading ??= (async () => {
      const before = status.peek();
      if (before !== 'ready') status.value = 'loading';
      try {
        const engine = await resolve();
        const loaded = await engine.ready();
        info.value = loaded;
        failure.value = null;
        status.value = 'ready';
        return loaded;
      } catch (error) {
        if (error instanceof PdfEngineError && error.code === 'cancelled') {
          // Disposed while loading: says nothing about whether the engine works.
          status.value = before;
        } else {
          markUnavailable(error);
        }
        return null;
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  }

  /** Watches the calls that pass through: they reveal the engine's state as a side effect. */
  async function observed<T>(call: (engine: PdfEngine) => Promise<T>): Promise<T> {
    try {
      const result = await call(await resolve());
      // A job went through, so the module is loaded; fetch the details for the About section.
      if (status.peek() !== 'ready' && !disposed) void load();
      return result;
    } catch (error) {
      if (error instanceof PdfEngineError && error.code === 'engine-unavailable') {
        markUnavailable(error);
      }
      throw error;
    }
  }

  const engine: PdfEngine = {
    ready: async () => (await resolve()).ready(),
    inspect: (file: Blob, password?: string, callOptions?: CallOptions): Promise<InspectResult> =>
      observed((real) => real.inspect(file, password, callOptions)),
    process: (request: ProcessRequest, callOptions?: ProcessCallOptions): Promise<ProcessResult> =>
      observed((real) => real.process(request, callOptions)),
    dispose: () => undefined,
  };

  return {
    status,
    info,
    failure,
    engine,
    load,
    preload() {
      if (preloadRequested || status.peek() !== 'idle') return;
      preloadRequested = true;
      (options.whenIdle ?? defaultWhenIdle)(() => {
        if (!disposed && status.peek() === 'idle') void load();
      });
    },
    retry() {
      return load();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      void created?.then(
        (real) => real.dispose(),
        () => undefined,
      );
    },
  };
}

/** True in a development build opened with `?fake`. Always false in production. */
export function isFakeEngineRequested(): boolean {
  if (!import.meta.env.DEV || typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).has('fake');
}

async function createForApp(): Promise<PdfEngine> {
  if (import.meta.env.DEV && isFakeEngineRequested()) {
    const fake = await import('../../tests/support/fake-engine');
    return fake.createFakeEngine(
      fake.fakeEngineOptionsFromUrl(new URLSearchParams(location.search)),
    );
  }
  return createPdfEngine();
}

/** The app's engine. Nothing is loaded by importing this module. */
export const engineState: EngineState = createEngineState({ create: createForApp });

export const engine: PdfEngine = engineState.engine;
export const engineStatus: ReadonlySignal<EngineStatus> = engineState.status;
export const engineInfo: ReadonlySignal<EngineInfo | null> = engineState.info;
