/**
 * Synchronous, environment-neutral core around the WebAssembly module.
 *
 * It knows nothing about workers, Blobs being cloned or UI types: it loads the module, lends it
 * byte sources and sinks, and turns its JSON responses into values or `PdfEngineError`s.
 * Everything here runs wherever it is called: in a Web Worker normally, on the main thread in the
 * fallback mode, in Node for tests and benchmarks.
 */
import createPdfx, { type PdfxHost, type PdfxModule } from './dist/pdfx.mjs';
import { toHex } from './passwords';
import {
  PdfEngineError,
  type AccessLevel,
  type CipherMethod,
  type EngineErrorCode,
  type Permissions,
} from './types';

// ---------------------------------------------------------------------------------------------
// Byte sources and sinks
// ---------------------------------------------------------------------------------------------

/** Random-access, synchronous view of the input document. */
export interface ByteSource {
  readonly size: number;
  /** Returns exactly `length` bytes starting at `offset`; the range is always inside the source. */
  read(offset: number, length: number): Uint8Array;
}

/** Receives the output in order. */
export interface ByteSink {
  /**
   * `chunk` is a view into the WebAssembly memory and only valid during the call: the sink must
   * copy what it wants to keep.
   */
  write(chunk: Uint8Array): void;
}

export class MemorySource implements ByteSource {
  readonly size: number;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.size = bytes.length;
  }

  read(offset: number, length: number): Uint8Array {
    return this.bytes.subarray(offset, offset + length);
  }
}

/** A list of chunks read as one contiguous source (the output of a sink, for verification). */
export class ChunkSource implements ByteSource {
  readonly size: number;
  private readonly chunks: readonly Uint8Array[];
  private readonly starts: number[] = [];

  constructor(chunks: readonly Uint8Array[]) {
    this.chunks = chunks;
    let total = 0;
    for (const chunk of chunks) {
      this.starts.push(total);
      total += chunk.length;
    }
    this.size = total;
  }

  read(offset: number, length: number): Uint8Array {
    // Last chunk starting at or before `offset`.
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.starts[mid]! <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    const first = this.chunks[low];
    const within = offset - (this.starts[low] ?? 0);
    if (first && within + length <= first.length) {
      return first.subarray(within, within + length);
    }
    const out = new Uint8Array(length);
    let done = 0;
    for (let i = low; i < this.chunks.length && done < length; i++) {
      const chunk = this.chunks[i]!;
      const from = i === low ? within : 0;
      const part = chunk.subarray(from, from + length - done);
      out.set(part, done);
      done += part.length;
    }
    return out.subarray(0, done);
  }
}

// Workers only; the DOM lib does not declare it.
declare class FileReaderSync {
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
}

/**
 * Reads a Blob slice by slice with FileReaderSync, so a File handed to a worker is never loaded
 * wholesale. Recent reads are remembered: an operation opens the document more than once (first
 * to learn how it is encrypted, then for real) and asks for the same ranges again.
 */
export class BlobSource implements ByteSource {
  private static readonly MEMO_BYTES = 4 * 1024 * 1024;

  readonly size: number;
  private readonly blob: Blob;
  private readonly reader = new FileReaderSync();
  private readonly memo = new Map<string, Uint8Array>();
  private memoBytes = 0;

  constructor(blob: Blob) {
    this.blob = blob;
    this.size = blob.size;
  }

  read(offset: number, length: number): Uint8Array {
    const key = `${offset}:${length}`;
    const known = this.memo.get(key);
    if (known) {
      return known;
    }
    const bytes = new Uint8Array(
      this.reader.readAsArrayBuffer(this.blob.slice(offset, offset + length)),
    );
    if (this.memoBytes + bytes.length <= BlobSource.MEMO_BYTES) {
      this.memo.set(key, bytes);
      this.memoBytes += bytes.length;
    }
    return bytes;
  }
}

// ---------------------------------------------------------------------------------------------
// Wire types (the JSON spoken by engine/src/pdfx.cc)
// ---------------------------------------------------------------------------------------------

export interface RawEncryption {
  revision: number;
  version: number;
  rawPermissions: number;
  keyBits: number;
  streamMethod: CipherMethod;
  stringMethod: CipherMethod;
  fileMethod: CipherMethod;
  encryptMetadata: boolean;
  permissions: Permissions;
}

export interface RawStats {
  /** Calls to `ByteSource.read`. */
  readCalls: number;
  bytesRead: number;
  evictions: number;
}

export interface RawInspect {
  fileSize: number;
  pdfVersion: string;
  extensionLevel: number | null;
  encrypted: boolean;
  access: AccessLevel;
  opensWithoutPassword: boolean;
  /** Index of the candidate that opened the document, -1 if none was needed or none worked. */
  matchedIndex: number;
  encryption: RawEncryption | null;
  pageCount: number | null;
  linearized: boolean | null;
  /** Total number of warnings; `warnings` holds at most the first 50. */
  warningCount: number;
  warnings: string[];
  stats: RawStats;
}

export interface RawProcess {
  input: Omit<RawInspect, 'stats'>;
  outputSize: number;
  pageCount: number;
  warningCount: number;
  warnings: string[];
  stats: RawStats;
}

export interface RawEncryptSpec {
  algorithm: 'aes-256' | 'aes-128';
  user: Uint8Array;
  owner: Uint8Array;
  permissions: Permissions;
  encryptMetadata: boolean;
}

export interface RawProcessSpec {
  operation: 'decrypt' | 'encrypt';
  encrypt?: RawEncryptSpec;
  streams: 'preserve' | 'compress';
  linearize: boolean;
}

/** I/O knobs of the WebAssembly side. The defaults are right for normal use. */
export interface IoTuning {
  /** Upper bound for cached input bytes (default 64 MiB). */
  cacheBytes?: number;
  /** Cache block size (default 64 KiB). */
  blockBytes?: number;
  /** Largest single read issued for sequential access (default 4 MiB). */
  maxReadBytes?: number;
  /** Size of the output chunks (default 1 MiB). */
  sinkBytes?: number;
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

const WASM_URL = new URL('./dist/pdfx.wasm', import.meta.url);

let compiled: Promise<WebAssembly.Module> | undefined;

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function compile(): Promise<WebAssembly.Module> {
  if (typeof WebAssembly !== 'object') {
    throw new Error('WebAssembly is not available');
  }
  if (WASM_URL.protocol === 'file:') {
    // Node (tests, benchmarks). The specifier is kept out of sight of the bundler on purpose.
    const specifier = 'node:fs/promises';
    const fs = (await import(/* @vite-ignore */ specifier)) as typeof import('node:fs/promises');
    return WebAssembly.compile(await fs.readFile(WASM_URL));
  }
  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      return await WebAssembly.compileStreaming(fetch(WASM_URL, { credentials: 'same-origin' }));
    } catch {
      // Wrong MIME type, or a failed request: the plain path below reports the real problem.
    }
  }
  const response = await fetch(WASM_URL, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${WASM_URL.pathname}`);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

/** Compiles the engine once per realm. Rejects with `engine-unavailable`. */
export function compileEngine(): Promise<WebAssembly.Module> {
  compiled ??= compile().catch((error: unknown) => {
    compiled = undefined; // allow a retry, e.g. after the network came back
    throw new PdfEngineError('engine-unavailable', describe(error));
  });
  return compiled;
}

// ---------------------------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------------------------

interface ActiveCall {
  source: ByteSource;
  sink?: ByteSink;
  onProgress?: (percent: number) => void;
  /** What a host callback caught; the module only learns "it failed". */
  hostError?: unknown;
}

const KNOWN_CODES: ReadonlySet<string> = new Set<EngineErrorCode>([
  'password-required',
  'password-incorrect',
  'not-encrypted',
  'not-pdf',
  'damaged',
  'unsupported-encryption',
  'password-not-encodable',
  'password-too-long',
  'password-missing',
  'read-failed',
  'out-of-memory',
  'cancelled',
  'engine-unavailable',
  'internal',
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function isOutOfMemory(error: unknown): boolean {
  return error instanceof RangeError || /out of memory|allocation failed/i.test(describe(error));
}

/** One instance of the WebAssembly module. Not re-entrant: one call at a time. */
export class PdfxCore {
  /** Version of the linked qpdf, e.g. "12.4.2". */
  readonly qpdfVersion: string;

  private readonly module: PdfxModule;
  private readonly calls: Map<number, ActiveCall>;
  private nextHandle = 1;
  private broken = false;

  private constructor(module: PdfxModule, calls: Map<number, ActiveCall>) {
    this.module = module;
    this.calls = calls;
    const info = JSON.parse(this.readCString(module._pdfx_version() >>> 0)) as { qpdf: string };
    this.qpdfVersion = info.qpdf;
  }

  static async create(): Promise<PdfxCore> {
    const wasm = await compileEngine();
    const calls = new Map<number, ActiveCall>();
    let module: PdfxModule | undefined;

    // Pointers arrive as signed 32-bit numbers once the heap grows past 2 GiB; `>>> 0` undoes that.
    const host: PdfxHost = {
      read(handle, offset, dest, length) {
        const call = calls.get(handle);
        if (!call || !module) {
          return -1;
        }
        try {
          const bytes = call.source.read(offset, length);
          if (bytes.length !== length) {
            throw new Error(`short read: ${bytes.length} of ${length} bytes at ${offset}`);
          }
          module.HEAPU8.set(bytes, dest >>> 0);
          return length;
        } catch (error) {
          call.hostError ??= error;
          return -1;
        }
      },
      write(handle, data, length) {
        const call = calls.get(handle);
        if (!call?.sink || !module) {
          return -1;
        }
        try {
          const start = data >>> 0;
          call.sink.write(module.HEAPU8.subarray(start, start + length));
          return 0;
        } catch (error) {
          call.hostError ??= error;
          return -1;
        }
      },
      progress(handle, percent) {
        try {
          calls.get(handle)?.onProgress?.(percent);
        } catch {
          // A misbehaving listener must not disturb the operation.
        }
      },
    };

    try {
      module = await new Promise<PdfxModule>((resolve, reject) => {
        createPdfx({
          pdfxHost: host,
          instantiateWasm(imports, receiveInstance) {
            WebAssembly.instantiate(wasm, imports).then(
              (instance) => receiveInstance(instance, wasm),
              reject,
            );
            return {};
          },
        }).then(resolve, reject);
      });
      return new PdfxCore(module, calls);
    } catch (error) {
      throw new PdfEngineError('engine-unavailable', describe(error));
    }
  }

  /** False after a trap: the instance must be thrown away and a new one created. */
  get usable(): boolean {
    return !this.broken;
  }

  /** Current size of the WebAssembly memory. It only ever grows. */
  get heapBytes(): number {
    return this.module.HEAPU8.length;
  }

  /**
   * Opens the document, trying the empty password and then each candidate. A wrong or missing
   * password is not an error here: it is reported as `access: 'locked'`.
   */
  inspect(source: ByteSource, candidates: readonly Uint8Array[], tuning?: IoTuning): RawInspect {
    return this.call<RawInspect>(
      '_pdfx_inspect',
      { size: source.size, passwords: candidates.map(toHex), ...tuning },
      { source },
    );
  }

  /** Decrypts or encrypts, streaming the result into `sink`. */
  process(
    source: ByteSource,
    candidates: readonly Uint8Array[],
    spec: RawProcessSpec,
    sink: ByteSink,
    onProgress?: (percent: number) => void,
    tuning?: IoTuning,
  ): RawProcess {
    const encrypt = spec.encrypt && {
      algorithm: spec.encrypt.algorithm,
      user: toHex(spec.encrypt.user),
      owner: toHex(spec.encrypt.owner),
      encryptMetadata: spec.encrypt.encryptMetadata,
      ...spec.encrypt.permissions,
    };
    return this.call<RawProcess>(
      '_pdfx_process',
      {
        size: source.size,
        passwords: candidates.map(toHex),
        operation: spec.operation,
        streams: spec.streams,
        linearize: spec.linearize,
        encrypt,
        ...tuning,
      },
      { source, sink, onProgress },
    );
  }

  private readCString(pointer: number): string {
    const heap = this.module.HEAPU8;
    let end = pointer;
    while (heap[end] !== 0) {
      end++;
    }
    return textDecoder.decode(heap.subarray(pointer, end));
  }

  private call<T>(
    entry: '_pdfx_inspect' | '_pdfx_process',
    request: Record<string, unknown>,
    active: ActiveCall,
  ): T {
    if (this.broken) {
      throw new PdfEngineError('internal', 'the engine instance crashed earlier');
    }
    const module = this.module;
    const handle = this.nextHandle;
    this.nextHandle = handle >= 0x7fffffff ? 1 : handle + 1;
    this.calls.set(handle, active);
    try {
      const json = textEncoder.encode(JSON.stringify({ ...request, handle }));
      const requestPointer = module._malloc(json.length + 1) >>> 0;
      if (requestPointer === 0) {
        throw new PdfEngineError('out-of-memory');
      }
      module.HEAPU8.set(json, requestPointer);
      module.HEAPU8[requestPointer + json.length] = 0;

      let responsePointer: number;
      try {
        responsePointer = module[entry](requestPointer) >>> 0;
      } catch (trap) {
        // C++ exceptions never leave the module, so this is a trap (stack exhaustion, a bug) or
        // the JS engine giving up. The instance's memory can no longer be trusted.
        this.broken = true;
        throw new PdfEngineError(
          isOutOfMemory(trap) ? 'out-of-memory' : 'internal',
          describe(trap),
        );
      }
      module._free(requestPointer);
      if (responsePointer === 0) {
        throw new PdfEngineError('out-of-memory');
      }
      const text = this.readCString(responsePointer);
      module._pdfx_free(responsePointer);

      const response = JSON.parse(text) as
        { ok: true; result: T } | { ok: false; error: { code: string; detail: string } };
      if (response.ok) {
        return response.result;
      }
      throw this.toError(response.error.code, response.error.detail, active);
    } finally {
      this.calls.delete(handle);
    }
  }

  private toError(code: string, detail: string, active: ActiveCall): PdfEngineError {
    const hostDetail = active.hostError === undefined ? undefined : describe(active.hostError);
    if (code === 'read-failed') {
      return new PdfEngineError('read-failed', hostDetail ?? detail);
    }
    if (code === 'write-failed') {
      // The sink could not take a chunk; the only realistic cause is memory.
      return new PdfEngineError(
        isOutOfMemory(active.hostError) ? 'out-of-memory' : 'internal',
        hostDetail ?? detail,
      );
    }
    if (KNOWN_CODES.has(code)) {
      return new PdfEngineError(code as EngineErrorCode, detail || undefined);
    }
    return new PdfEngineError('internal', `${code}: ${detail}`);
  }
}
