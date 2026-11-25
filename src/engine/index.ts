/**
 * Entry point of the PDF engine. The UI imports from here only.
 *
 * CONTRACT STUB — `createPdfEngine` is implemented in `./client.ts` by the engine workstream.
 */
import type { PdfEngine } from './types';

export * from './types';

export interface CreateEngineOptions {
  /** Upper bound for parallel workers. Default: derived from `navigator.hardwareConcurrency`. */
  maxWorkers?: number;
}

export function createPdfEngine(_options?: CreateEngineOptions): PdfEngine {
  throw new Error('not implemented');
}
