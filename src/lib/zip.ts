/** Minimal ZIP writer. CONTRACT STUB — implemented by the platform workstream. */
import type { OutputFile } from './save';

/**
 * Builds a ZIP archive (STORE method — PDFs are already compressed) without loading all files
 * into memory at once. UTF-8 file names; ZIP64 when sizes or counts require it.
 */
export function createZip(_files: readonly OutputFile[]): Promise<Blob> {
  throw new Error('not implemented');
}
