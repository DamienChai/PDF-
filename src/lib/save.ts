/**
 * Getting results out of the app: save dialog, download, system share sheet.
 *
 * Every function here must be called from a user gesture (click / key press). Pickers and the
 * share sheet are therefore always opened before any slow work, while the gesture is still fresh.
 */
import { firstFreeName, nameKey, sanitizeFileName, uniqueNames } from './filename';
import { createZip } from './zip';

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

const PDF_TYPE = 'application/pdf';
const ZIP_TYPE = 'application/zip';

/**
 * How long blob: URLs stay alive after being handed to the browser. Downloads may sit behind a
 * confirmation prompt (iOS, Android) and a viewer tab may be reloaded, so this is generous; the
 * Blob itself is kept alive by the app anyway.
 */
export const BLOB_URL_LIFETIME_MS = 10 * 60 * 1000;

/** Lets the browser remember the last folder separately for single files and for folders. */
const PICKER_ID_FILE = 'pdfkey-save';
const PICKER_ID_DIRECTORY = 'pdfkey-folder';

// --- File System Access API (not part of the TypeScript DOM library) ---------------------------

interface FilePickerType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: FilePickerType[];
  id?: string;
  startIn?: string;
}

interface DirectoryPickerOptions {
  mode?: 'read' | 'readwrite';
  id?: string;
  startIn?: string;
}

interface FileSystemAccessScope {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
}

function scope(): typeof globalThis & FileSystemAccessScope {
  return globalThis;
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}

/** The user dismissed a picker or the share sheet. */
function isAbort(error: unknown): boolean {
  return errorName(error) === 'AbortError';
}

function mimeTypeFor(name: string): string {
  return name.toLowerCase().endsWith('.zip') ? ZIP_TYPE : PDF_TYPE;
}

/** Re-labels a Blob without copying its data. */
function withType(blob: Blob, type: string): Blob {
  return blob.type === type ? blob : blob.slice(0, blob.size, type);
}

// --- Capabilities ------------------------------------------------------------------------------

export function getSaveCapabilities(): SaveCapabilities {
  return {
    canShareFiles: canSharePdf(),
    canPickSaveLocation: typeof scope().showSaveFilePicker === 'function',
    canPickDirectory: typeof scope().showDirectoryPicker === 'function',
  };
}

function canSharePdf(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return false;
  }
  try {
    const probe = new File([new Uint8Array(1)], 'document.pdf', { type: PDF_TYPE });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

// --- Saving ------------------------------------------------------------------------------------

/** Saves one file: native "Save as" dialog where available, otherwise a normal download. */
export function saveFile(file: OutputFile): Promise<SaveOutcome> {
  return saveNamedBlob(sanitizeFileName(file.name), () => file.blob);
}

/** Bundles all files into `zipName` (must end in `.zip`) and saves that. */
export function saveAsZip(files: readonly OutputFile[], zipName: string): Promise<SaveOutcome> {
  let name = sanitizeFileName(zipName);
  if (!name.toLowerCase().endsWith('.zip')) name = sanitizeFileName(`${name}.zip`);
  return saveNamedBlob(name, () => createZip(files));
}

/**
 * `produce` runs only after the user has chosen a destination: opening the picker needs the
 * user gesture, which would have expired by the time a large archive is assembled.
 */
async function saveNamedBlob(
  name: string,
  produce: () => Blob | Promise<Blob>,
): Promise<SaveOutcome> {
  const type = mimeTypeFor(name);
  const handle = await pickSaveLocation(name, type);
  if (handle === 'cancelled') return 'cancelled';
  const blob = withType(await produce(), type);
  if (handle === 'unavailable') {
    download(name, blob);
    return 'downloaded';
  }
  await writeToHandle(handle, blob);
  return 'saved';
}

async function pickSaveLocation(
  name: string,
  type: string,
): Promise<FileSystemFileHandle | 'cancelled' | 'unavailable'> {
  const picker = scope().showSaveFilePicker;
  if (typeof picker !== 'function') return 'unavailable';
  const extension = type === ZIP_TYPE ? '.zip' : '.pdf';
  try {
    return await picker.call(scope(), {
      suggestedName: name,
      types: [{ description: type === ZIP_TYPE ? 'ZIP' : 'PDF', accept: { [type]: [extension] } }],
      id: PICKER_ID_FILE,
      startIn: 'downloads',
    });
  } catch (error) {
    if (isAbort(error)) return 'cancelled';
    // No user activation left, embedded in a frame without permission, picker blocked by policy,
    // a name the picker rejects …: a plain download still gets the file to the user.
    return 'unavailable';
  }
}

async function writeToHandle(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    // Discards the temporary file instead of leaving a truncated document behind.
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

/**
 * Hands the file straight to the browser's download manager, without a dialog. For a one-tap
 * "Download" next to "Save as…", e.g. on phones where a folder picker is more than the user wants.
 */
export function downloadFile(file: OutputFile): SaveOutcome {
  const name = sanitizeFileName(file.name);
  download(name, withType(file.blob, mimeTypeFor(name)));
  return 'downloaded';
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_LIFETIME_MS);
}

/** Writes all files into a folder chosen by the user. Rejects if `canPickDirectory` is false. */
export async function saveToDirectory(files: readonly OutputFile[]): Promise<SaveOutcome> {
  const picker = scope().showDirectoryPicker;
  if (typeof picker !== 'function') {
    throw new DOMException(
      'Choosing a folder is not supported by this browser.',
      'NotSupportedError',
    );
  }
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await picker.call(scope(), {
      mode: 'readwrite',
      id: PICKER_ID_DIRECTORY,
      startIn: 'downloads',
    });
  } catch (error) {
    if (isAbort(error)) return 'cancelled';
    throw error;
  }

  const names = uniqueNames(files.map((file) => sanitizeFileName(file.name)));
  const reserved = new Set(names.map(nameKey));
  for (const [index, file] of files.entries()) {
    const wanted = names[index]!;
    // Never overwrite: not a file already in the folder, and not a name another file of this
    // batch is going to use.
    const name = await firstFreeName(
      wanted,
      async (candidate) =>
        (candidate !== wanted && reserved.has(nameKey(candidate))) ||
        (await entryExists(directory, candidate)),
    );
    reserved.add(nameKey(name));
    await writeNewFile(directory, name, withType(file.blob, mimeTypeFor(name)));
  }
  return 'saved';
}

async function entryExists(directory: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (errorName(error) === 'NotFoundError') return false;
    // A sub-folder of that name: taken as well.
    if (errorName(error) === 'TypeMismatchError') return true;
    throw error;
  }
}

async function writeNewFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  blob: Blob,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  try {
    await writeToHandle(handle, blob);
  } catch (error) {
    // Remove the empty placeholder that `create: true` left behind.
    await directory.removeEntry(name).catch(() => undefined);
    throw error;
  }
}

// --- Sharing -----------------------------------------------------------------------------------

/** Opens the system share sheet with the given files. */
export async function shareFiles(
  files: readonly OutputFile[],
  title?: string,
): Promise<ShareOutcome> {
  if (files.length === 0 || typeof navigator === 'undefined') return 'unsupported';
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return 'unsupported';
  }
  const names = uniqueNames(files.map((file) => sanitizeFileName(file.name)));
  const data: ShareData = {
    // Share targets decide by MIME type what they offer to do with a file.
    files: files.map(
      (file, index) => new File([file.blob], names[index]!, { type: mimeTypeFor(names[index]!) }),
    ),
  };
  if (title) data.title = title;
  try {
    if (!navigator.canShare(data)) return 'unsupported';
    await navigator.share(data);
    return 'shared';
  } catch (error) {
    if (isAbort(error)) return 'cancelled';
    // NotAllowedError: file type or size refused, or the gesture expired. TypeError: this
    // combination of data cannot be shared. Either way the caller should offer saving instead.
    if (errorName(error) === 'NotAllowedError' || errorName(error) === 'TypeError') {
      return 'unsupported';
    }
    throw error;
  }
}

// --- Viewing -----------------------------------------------------------------------------------

/** Opens the file in a new tab using the browser's PDF viewer. */
export function openInNewTab(file: OutputFile): void {
  const url = URL.createObjectURL(withType(file.blob, PDF_TYPE));
  // A link click (rather than window.open) is treated like any user-initiated navigation and
  // gives the new tab no handle on this window.
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_LIFETIME_MS);
}
