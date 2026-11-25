/**
 * Files handed to the app from outside: Android share sheet (Web Share Target) and
 * "Open with" on desktop (File Handling API / launch queue).
 * CONTRACT STUB — implemented by the platform workstream.
 */

export type IncomingSource = 'share-target' | 'file-handler';

/**
 * Registers the single consumer for incoming files. Files that arrived before registration are
 * delivered once, right after registering. Returns an unsubscribe function.
 */
export function onIncomingFiles(
  _handler: (files: File[], source: IncomingSource) => void,
): () => void {
  throw new Error('not implemented');
}
