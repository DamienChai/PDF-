/**
 * Serves engine requests with a WebAssembly core: the body of the worker, and of the in-process
 * channel used when workers are unavailable.
 */
import { BlobSource, MemorySource, PdfxCore, type ByteSource, type IoTuning } from './core';
import {
  BlobOutputSink,
  MemoryOutputSink,
  inspectDocument,
  processDocument,
  type OutputSink,
} from './jobs';
import type { HostChannel, HostRequest, HostResponse } from './protocol';
import { PdfEngineError } from './types';

/** How a host gets at file contents and stores output in its environment. */
export interface HostEnvironment {
  openSource(file: Blob): ByteSource | Promise<ByteSource>;
  createSink(): OutputSink;
}

/** Worker: synchronous, lazy Blob reads and Blob-backed output. */
export const workerEnvironment: HostEnvironment = {
  openSource: (file) => new BlobSource(file),
  createSink: () => new BlobOutputSink(),
};

/** Anywhere else: the file is read into memory first (there is no synchronous Blob API). */
export const inMemoryEnvironment: HostEnvironment = {
  openSource: async (file) => new MemorySource(new Uint8Array(await file.arrayBuffer())),
  createSink: () => new MemoryOutputSink(),
};

/**
 * WebAssembly memory never shrinks. After a job that made it grow well beyond its initial 32 MiB
 * the instance is dropped so the memory goes back to the system; the next job gets a fresh one
 * (the compiled module is kept, so that costs a few milliseconds).
 */
const RECYCLE_HEAP_BYTES = 48 * 1024 * 1024;

/**
 * The input cache defaults to 64 MiB, which keeps almost every PDF fully cached. Throughput does
 * not depend on it (large files are copied sequentially), so devices that report little memory
 * get a smaller one. `deviceMemory` is in GiB and only exists in Chromium.
 */
function deviceTuning(): IoTuning | undefined {
  const memory = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory;
  if (memory === undefined || memory > 4) {
    return undefined;
  }
  return { cacheBytes: (memory > 2 ? 32 : 16) * 1024 * 1024 };
}

function toFailure(id: number, error: unknown): HostResponse {
  if (error instanceof PdfEngineError) {
    return { type: 'failed', id, code: error.code, detail: error.detail };
  }
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { type: 'failed', id, code: 'internal', detail };
}

export class EngineHost {
  private readonly environment: HostEnvironment;
  private readonly post: (response: HostResponse) => void;
  private core: PdfxCore | undefined;
  private readonly tuning = deviceTuning();
  /** Requests are served strictly one after the other. */
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(environment: HostEnvironment, post: (response: HostResponse) => void) {
    this.environment = environment;
    this.post = post;
  }

  /** Queues a request. Never throws; every request is answered through `post`. */
  handle(request: HostRequest): void {
    this.tail = this.tail.then(() => (this.stopped ? undefined : this.serve(request)));
  }

  /** Drops the requests that have not started yet and releases the WebAssembly instance. */
  stop(): void {
    this.stopped = true;
    this.core = undefined;
  }

  private async getCore(): Promise<PdfxCore> {
    if (!this.core?.usable) {
      this.core = undefined;
      this.core = await PdfxCore.create();
    }
    return this.core;
  }

  private release(): void {
    if (this.core && (!this.core.usable || this.core.heapBytes > RECYCLE_HEAP_BYTES)) {
      this.core = undefined;
    }
  }

  private async serve(request: HostRequest): Promise<void> {
    if (request.type === 'init') {
      try {
        this.post({ type: 'ready', qpdfVersion: (await this.getCore()).qpdfVersion });
      } catch (error) {
        const detail = error instanceof PdfEngineError ? error.detail : String(error);
        this.post({ type: 'unavailable', detail });
      }
      return;
    }
    const { id } = request;
    try {
      const core = await this.getCore();
      let source: ByteSource;
      try {
        source = await this.environment.openSource(request.file);
      } catch (error) {
        throw new PdfEngineError('read-failed', String(error));
      }
      if (request.type === 'inspect') {
        this.post({
          type: 'inspected',
          id,
          result: inspectDocument(core, source, request.password, this.tuning),
        });
      } else {
        const result = processDocument(
          core,
          source,
          request,
          this.environment.createSink(),
          (fraction) => this.post({ type: 'progress', id, fraction }),
          this.tuning,
        );
        this.post({ type: 'processed', id, result });
      }
    } catch (error) {
      this.post(toFailure(id, error));
    } finally {
      this.release();
    }
  }
}

/**
 * An engine host in the current thread behind the channel interface of a worker. Responses are
 * delivered asynchronously, like worker messages.
 */
export function createLocalChannel(
  environment: HostEnvironment = inMemoryEnvironment,
): HostChannel {
  let terminated = false;
  const channel: HostChannel = {
    onmessage: null,
    onerror: null,
    postMessage(request) {
      if (!terminated) {
        host.handle(request);
      }
    },
    terminate() {
      terminated = true;
      host.stop();
    },
  };
  const host = new EngineHost(environment, (response) => {
    queueMicrotask(() => {
      if (!terminated) {
        channel.onmessage?.({ data: response });
      }
    });
  });
  return channel;
}
