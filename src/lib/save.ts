/**
 * Getting results out of the app: save dialog, download, system share sheet.
 * CONTRACT STUB — bodies are implemented by the platform workstream.
 *
 * Every function here must be called from a user gesture (click / key press).
 */

export interface OutputFile {
  /** File name including the `.pdf` extension. */
  name: string;
  blob: Blob;
}

export interface SaveCapabilities {
  /** `navigator.share` accepts PDF files (Android, iOS, recent desktop browsers). */
  canShareFiles: boolean;
  /** A native "Save as" dialog is available (`showSaveFilePicker`). */
  canPickSaveLocation: boolean;
  /** A folder can be chosen for writing several files (`showDirectoryPicker`). */
  canPickDirectory: boolean;
}

/** `saved` = written through a picker; `downloaded` = handed to the browser's download manager. */
export type SaveOutcome = 'saved' | 'downloaded' | 'cancelled';
export type ShareOutcome = 'shared' | 'cancelled' | 'unsupported';

export function getSaveCapabilities(): SaveCapabilities {
  throw new Error('not implemented');
}

/** Saves one file: native "Save as" dialog where available, otherwise a normal download. */
export function saveFile(_file: OutputFile): Promise<SaveOutcome> {
  throw new Error('not implemented');
}

/** Writes all files into a folder chosen by the user. Rejects if `canPickDirectory` is false. */
export function saveToDirectory(_files: readonly OutputFile[]): Promise<SaveOutcome> {
  throw new Error('not implemented');
}

/** Bundles all files into `zipName` (must end in `.zip`) and saves that. */
export function saveAsZip(_files: readonly OutputFile[], _zipName: string): Promise<SaveOutcome> {
  throw new Error('not implemented');
}

/** Opens the system share sheet with the given files. */
export function shareFiles(_files: readonly OutputFile[], _title?: string): Promise<ShareOutcome> {
  throw new Error('not implemented');
}

/** Opens the file in a new tab using the browser's PDF viewer. */
export function openInNewTab(_file: OutputFile): void {
  throw new Error('not implemented');
}
