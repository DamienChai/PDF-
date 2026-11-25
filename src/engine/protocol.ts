/**
 * Messages between the engine client (`client.ts`) and an engine host (`host.ts`), which normally
 * lives in a Web Worker. Private to `src/engine/`.
 */
import type {
  EngineErrorCode,
  InspectResult,
  Operation,
  OutputOptions,
  ProcessResult,
} from './types';

export type HostRequest =
  /** Load the WebAssembly module now. Answered with `ready` or `unavailable`. */
  | { type: 'init' }
  | { type: 'inspect'; id: number; file: Blob; password: string }
  | {
      type: 'process';
      id: number;
      file: Blob;
      password: string;
      operation: Operation;
      output: Partial<OutputOptions> | undefined;
    };

export type HostResponse =
  | { type: 'ready'; qpdfVersion: string }
  | { type: 'unavailable'; detail: string | undefined }
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'inspected'; id: number; result: InspectResult }
  | { type: 'processed'; id: number; result: ProcessResult }
  | { type: 'failed'; id: number; code: EngineErrorCode; detail: string | undefined };

/** The part of `Worker` the client uses; also implemented in-process for the fallback mode. */
export interface HostChannel {
  postMessage(request: HostRequest): void;
  terminate(): void;
  onmessage: ((event: { data: HostResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
