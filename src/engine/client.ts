/**
 * The engine as the UI sees it: a lazy pool of workers behind the `PdfEngine` interface.
 *
 * Jobs are queued first-in first-out and each worker runs one job at a time. Aborting a running
 * job terminates its worker (the WebAssembly call is synchronous, there is no other way to stop
 * it); a replacement is spawned when the next job needs one. If workers cannot be used at all the
 * engine runs in the calling thread instead.
 */
import type { HostChannel, HostRequest, HostResponse } from './protocol';
import {
  PdfEngineError,
  type CallOptions,
  type EngineInfo,
  type InspectResult,
  type PdfEngine,
  type ProcessCallOptions,
  type ProcessRequest,
  type ProcessResult,
} from './types';

export interface CreateEngineOptions {
  /** Upper bound for parallel workers. Default: derived from `navigator.hardwareConcurrency`. */
  maxWorkers?: number;
}

/** Seams for tests. Not part of the public contract. */
export interface EngineInternals {
  /** Creates a worker-like channel. Throwing makes the engine fall back to the calling thread. */
  spawnWorker?: () => HostChannel;
}

interface Job {
  id: number;
  toRequest(): HostRequest;
  resolve(value: InspectResult | ProcessResult): void;
  reject(error: PdfEngineError): void;
  onProgress: ((fraction: number) => void) | undefined;
  lastFraction: number;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  settled: boolean;
}

interface Slot {
  channel: HostChannel;
  /** Runs in the calling thread (fallback mode). */
  local: boolean;
  job: Job | undefined;
  /** Has sent at least one message, i.e. its script loaded and runs. */
  alive: boolean;
  /** Outcome of the latest `init` request: the qpdf version, once the module is loaded. */
  version: Promise<string>;
  /** The latest `init` was answered with `unavailable`; asking again may succeed. */
  initFailed: boolean;
  resolveVersion(version: string): void;
  rejectVersion(reason: unknown): void;
}

/**
 * Rejection reason of `Slot.version` when the slot went away for a reason that says nothing about
 * the engine (its job was aborted, the engine left worker mode): whoever waits should ask the
 * slot that takes its place.
 */
const SLOT_REPLACED = Symbol('slot replaced');

function defaultWorkerCount(): number {
  const cores = typeof navigator === 'object' ? navigator.hardwareConcurrency : undefined;
  return Math.min(4, Math.max(1, Math.floor((cores ?? 2) / 2)));
}

function spawnModuleWorker(): HostChannel {
  // Vite recognises this exact expression and bundles the worker as its own entry.
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'pdf-key-engine',
  });
  return worker as unknown as HostChannel;
}

/**
 * The in-process host behind a channel. It is imported on demand so that the WebAssembly glue is
 * not part of the main bundle when workers do their job.
 */
function spawnLocalChannel(): HostChannel {
  let inner: HostChannel | undefined;
  let terminated = false;
  const backlog: HostRequest[] = [];
  const outer: HostChannel = {
    onmessage: null,
    onerror: null,
    postMessage(request) {
      if (inner) {
        inner.postMessage(request);
      } else {
        backlog.push(request);
      }
    },
    terminate() {
      terminated = true;
      inner?.terminate();
    },
  };
  import('./host').then(
    ({ createLocalChannel }) => {
      if (terminated) {
        return;
      }
      inner = createLocalChannel();
      inner.onmessage = (event) => outer.onmessage?.(event);
      inner.onerror = (event) => outer.onerror?.(event);
      for (const request of backlog) {
        inner.postMessage(request);
      }
      backlog.length = 0;
    },
    (error: unknown) => {
      if (!terminated) {
        outer.onerror?.(error);
      }
    },
  );
  return outer;
}

function describeCrash(event: unknown): string {
  if (typeof event === 'object' && event !== null && 'message' in event) {
    const message = (event as { message: unknown }).message;
    if (typeof message === 'string' && message !== '') {
      return message;
    }
  }
  return event instanceof Error ? event.message : 'no details available';
}

class EngineClient implements PdfEngine {
  private readonly maxWorkers: number;
  private readonly spawnWorker: (() => HostChannel) | undefined;
  private mode: EngineInfo['mode'];
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private nextId = 1;
  private disposed = false;
  /** A worker has answered at least once: workers work here, a later failure is a crash. */
  private workersProven = false;

  constructor(options: CreateEngineOptions, internals: EngineInternals) {
    const requested = options.maxWorkers ?? defaultWorkerCount();
    this.maxWorkers = Math.max(1, Math.floor(Number.isFinite(requested) ? requested : 1));
    this.spawnWorker =
      internals.spawnWorker ?? (typeof Worker === 'function' ? spawnModuleWorker : undefined);
    this.mode = this.spawnWorker ? 'worker' : 'main-thread';
  }

  // --- PdfEngine --------------------------------------------------------------------------

  async ready(): Promise<EngineInfo> {
    for (;;) {
      this.assertNotDisposed();
      const slot = this.slots[0] ?? this.addSlot();
      if (slot.initFailed) {
        this.requestInit(slot); // e.g. the network was down the first time
      }
      try {
        const qpdfVersion = await slot.version;
        return { qpdfVersion, concurrency: this.limit(), mode: this.mode };
      } catch (reason) {
        if (reason !== SLOT_REPLACED) {
          throw reason;
        }
      }
    }
  }

  inspect(file: Blob, password = '', options?: CallOptions): Promise<InspectResult> {
    return this.submit<InspectResult>(
      (id) => ({ type: 'inspect', id, file, password }),
      options?.signal,
      undefined,
    );
  }

  process(request: ProcessRequest, options?: ProcessCallOptions): Promise<ProcessResult> {
    const { file, password, operation, output } = request;
    return this.submit<ProcessResult>(
      (id) => ({ type: 'process', id, file, password, operation, output }),
      options?.signal,
      options?.onProgress,
    );
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const cancelled = (): PdfEngineError =>
      new PdfEngineError('cancelled', 'the engine was disposed');
    for (const slot of this.slots.slice()) {
      const job = slot.job;
      this.removeSlot(slot, cancelled());
      if (job) {
        this.settle(job, undefined, cancelled());
      }
    }
    for (const job of this.queue.splice(0)) {
      this.settle(job, undefined, cancelled());
    }
  }

  // --- queue --------------------------------------------------------------------------------

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new PdfEngineError('cancelled', 'the engine was disposed');
    }
  }

  private limit(): number {
    return this.mode === 'worker' ? this.maxWorkers : 1;
  }

  private submit<T extends InspectResult | ProcessResult>(
    toRequest: (id: number) => HostRequest,
    signal: AbortSignal | undefined,
    onProgress: ((fraction: number) => void) | undefined,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.assertNotDisposed();
      if (signal?.aborted) {
        throw new PdfEngineError('cancelled');
      }
      const id = this.nextId++;
      const job: Job = {
        id,
        toRequest: () => toRequest(id),
        resolve: resolve as Job['resolve'],
        reject,
        onProgress,
        lastFraction: -1,
        signal,
        onAbort: undefined,
        settled: false,
      };
      if (signal) {
        job.onAbort = () => this.abort(job);
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let slot = this.slots.find((s) => !s.job);
      if (!slot) {
        if (this.slots.length >= this.limit()) {
          return;
        }
        slot = this.addSlot();
      }
      const job = this.queue.shift()!;
      slot.job = job;
      try {
        slot.channel.postMessage(job.toRequest());
      } catch (error) {
        slot.job = undefined;
        this.settle(job, undefined, new PdfEngineError('internal', String(error)));
      }
    }
  }

  private settle(
    job: Job,
    value: InspectResult | ProcessResult | undefined,
    error: PdfEngineError | undefined,
  ): void {
    if (job.settled) {
      return;
    }
    job.settled = true;
    if (job.signal && job.onAbort) {
      job.signal.removeEventListener('abort', job.onAbort);
    }
    if (error) {
      job.reject(error);
    } else {
      this.reportProgress(job, 1);
      job.resolve(value!);
    }
  }

  private reportProgress(job: Job, fraction: number): void {
    const clamped = Math.min(1, Math.max(0, fraction));
    if (!job.onProgress || !(clamped > job.lastFraction)) {
      return;
    }
    job.lastFraction = clamped;
    try {
      job.onProgress(clamped);
    } catch {
      // A listener that throws must not take the job down with it.
    }
  }

  private abort(job: Job): void {
    if (job.settled) {
      return;
    }
    const queued = this.queue.indexOf(job);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
    } else {
      const slot = this.slots.find((s) => s.job === job);
      if (slot) {
        // The only way to stop a running job. A new worker is spawned when one is needed.
        this.removeSlot(slot, SLOT_REPLACED);
      }
    }
    this.settle(job, undefined, new PdfEngineError('cancelled'));
    this.pump();
  }

  // --- slots --------------------------------------------------------------------------------

  private addSlot(): Slot {
    let channel: HostChannel | undefined;
    if (this.mode === 'worker' && this.spawnWorker) {
      try {
        channel = this.spawnWorker();
      } catch {
        // Workers cannot be created here. (If some already run, they keep serving; the limit
        // of the fallback mode just prevents further attempts.)
        this.mode = 'main-thread';
      }
    }
    const local = !channel;
    channel ??= spawnLocalChannel();

    const slot: Slot = {
      channel,
      local,
      job: undefined,
      alive: false,
      version: Promise.resolve(''),
      initFailed: false,
      resolveVersion: () => undefined,
      rejectVersion: () => undefined,
    };
    channel.onmessage = (event) => this.onMessage(slot, event.data);
    channel.onerror = (event) => this.onCrash(slot, event);
    this.slots.push(slot);
    this.requestInit(slot);
    return slot;
  }

  /** Asks the slot to load the WebAssembly module; `slot.version` follows the answer. */
  private requestInit(slot: Slot): void {
    slot.initFailed = false;
    slot.version = new Promise<string>((resolve, reject) => {
      slot.resolveVersion = resolve;
      slot.rejectVersion = reject;
    });
    slot.version.catch(() => undefined); // nobody may be waiting for it
    slot.channel.postMessage({ type: 'init' });
  }

  private removeSlot(slot: Slot, versionRejection: unknown): void {
    const index = this.slots.indexOf(slot);
    if (index >= 0) {
      this.slots.splice(index, 1);
    }
    slot.channel.onmessage = null;
    slot.channel.onerror = null;
    slot.channel.terminate();
    slot.rejectVersion(versionRejection);
    slot.job = undefined;
  }

  private onMessage(slot: Slot, message: HostResponse): void {
    slot.alive = true;
    if (!slot.local) {
      this.workersProven = true;
    }
    switch (message.type) {
      case 'ready':
        slot.resolveVersion(message.qpdfVersion);
        return;
      case 'unavailable':
        slot.initFailed = true;
        slot.rejectVersion(new PdfEngineError('engine-unavailable', message.detail));
        return;
      case 'progress':
        if (slot.job?.id === message.id) {
          this.reportProgress(slot.job, message.fraction);
        }
        return;
      case 'inspected':
      case 'processed':
      case 'failed': {
        const job = slot.job;
        if (job?.id !== message.id) {
          return;
        }
        slot.job = undefined;
        if (message.type === 'failed') {
          this.settle(job, undefined, new PdfEngineError(message.code, message.detail));
        } else {
          this.settle(job, message.result, undefined);
        }
        this.pump();
      }
    }
  }

  private onCrash(slot: Slot, event: unknown): void {
    if (!this.slots.includes(slot)) {
      return;
    }
    const job = slot.job;
    const detail = describeCrash(event);

    if (!slot.local && !slot.alive && !this.workersProven) {
      // No worker has ever answered: the worker script cannot be loaded or run here (module
      // workers unsupported, blocked by policy, …). Carry on in this thread.
      this.mode = 'main-thread';
      const requeued: Job[] = [];
      for (const other of this.slots.slice()) {
        if (other.job) {
          requeued.push(other.job);
        }
        this.removeSlot(other, SLOT_REPLACED);
      }
      requeued.sort((a, b) => a.id - b.id);
      this.queue.unshift(...requeued);
      this.pump();
      return;
    }

    const error = slot.local
      ? new PdfEngineError('engine-unavailable', detail)
      : new PdfEngineError('internal', `the engine worker crashed: ${detail}`);
    this.removeSlot(slot, error);
    if (job) {
      this.settle(job, undefined, error);
    }
    this.pump();
  }
}

export function createEngineClient(
  options: CreateEngineOptions = {},
  internals: EngineInternals = {},
): PdfEngine {
  return new EngineClient(options, internals);
}
