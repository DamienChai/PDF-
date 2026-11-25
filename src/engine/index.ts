/**
 * Entry point of the PDF engine. The UI imports from here only.
 */
import { createEngineClient, type CreateEngineOptions } from './client';
import type { PdfEngine } from './types';

export * from './types';
export type { CreateEngineOptions } from './client';
export { checkNewPasswords, type NewPasswordProblem } from './passwords';

/**
 * Creates an engine. Nothing is loaded until the first call (or `ready()`); the WebAssembly
 * module and the workers are fetched from the app's own static files.
 */
export function createPdfEngine(options?: CreateEngineOptions): PdfEngine {
  return createEngineClient(options);
}
