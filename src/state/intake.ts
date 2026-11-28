/**
 * The ways files get into the app from the page itself: the system file picker, drag and drop
 * onto the window, and paste. (Files shared to or opened with the installed app arrive through
 * src/pwa/incoming.ts and are wired up in app.ts.)
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import type { Message } from '../i18n';
import { FOLDER_LIMITS, readFolders, type FolderLimits } from '../lib/folders';
import type { FileSource } from './jobs';
import type { ToastTone } from './toasts';

export interface Intake {
  /** Files are being dragged over the window: show the drop overlay. */
  readonly dragActive: ReadonlySignal<boolean>;
  /** Opens the system file picker for PDFs. Call it directly from a click handler. */
  pickFiles(): void;
  /**
   * Listens for drag and drop and paste on the window from now on. Dropping a file anywhere on
   * the page adds it (and never navigates away to it); dropping a folder adds the PDFs inside.
   * Returns a function that stops listening.
   */
  attach(): () => void;
}

type Listeners = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** Everything this module needs from the browser and the app; replaced by fakes in tests. */
export interface IntakeEnvironment {
  addFiles(files: File[], source: FileSource): void;
  /** The window; absent outside a browser. */
  target?: Listeners | undefined;
  /** Shows the system file picker and reports the chosen files (nothing if dismissed). */
  openPicker?: ((onFiles: (files: File[]) => void) => void) | undefined;
  /** Tells the user what happened to a folder that did not simply turn into files. */
  notify?: ((message: Message, tone: ToastTone) => void) | undefined;
  /** How far a dropped folder is read. */
  folderLimits?: FolderLimits | undefined;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * Browsers keep firing `dragover` while something is dragged over the page. If none arrives for
 * this long the drag has ended without telling us (left the window, cancelled with Escape, the
 * element under the pointer was removed), and the overlay must not stay.
 */
export const DRAG_IDLE_MS = 1000;

const DRAG_EVENTS = ['dragenter', 'dragover', 'dragleave', 'drop', 'paste'] as const;

/** A drag carries files (as opposed to text, links or elements of the page itself). */
function carriesFiles(transfer: DataTransfer | null | undefined): transfer is DataTransfer {
  if (!transfer) return false;
  // `types` is an array in current browsers and was a DOMStringList in old ones.
  return Array.prototype.indexOf.call(transfer.types ?? [], 'Files') >= 0;
}

/**
 * Everything of a drop or paste that the browser presents as a file. A folder is among them, as
 * a `File` that cannot be read; `sortTransfer` tells the two apart.
 */
export function filesFromTransfer(transfer: DataTransfer | null | undefined): File[] {
  return transfer?.files ? Array.from(transfer.files) : [];
}

interface Sorted {
  files: File[];
  folders: FileSystemDirectoryEntry[];
  /** Files or folders: this browser does not say which. */
  unsorted: File[];
}

/**
 * Separates dropped files from dropped folders. Must run inside the event handler: the items of
 * a transfer are gone once the handler returns.
 */
function sortTransfer(transfer: DataTransfer): Sorted {
  const items = transfer.items ? Array.from(transfer.items) : [];
  const fileItems = items.filter((item) => item.kind === 'file');
  if (
    fileItems.length === 0 ||
    fileItems.some((item) => typeof item.webkitGetAsEntry !== 'function')
  ) {
    return { files: [], folders: [], unsorted: filesFromTransfer(transfer) };
  }
  const sorted: Sorted = { files: [], folders: [], unsorted: [] };
  for (const item of fileItems) {
    // null for a file that does not come from the file system (a synthetic drop, some pastes).
    const entry = item.webkitGetAsEntry();
    if (entry?.isDirectory) {
      sorted.folders.push(entry as FileSystemDirectoryEntry);
    } else {
      const file = item.getAsFile();
      if (file) sorted.files.push(file);
    }
  }
  return sorted;
}

/** A folder has a `File` too, but its content cannot be read. */
function isReadable(file: File): Promise<boolean> {
  return file
    .slice(0, 1)
    .arrayBuffer()
    .then(
      () => true,
      () => false,
    );
}

export function createIntake(env: IntakeEnvironment): Intake {
  const dragActive = signal(false);
  const setTimer = env.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    env.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  /** `dragenter` minus `dragleave`: above zero while the pointer is somewhere inside the page. */
  let depth = 0;
  let watchdog: unknown;

  function endDrag(): void {
    depth = 0;
    clearTimer(watchdog);
    watchdog = undefined;
    dragActive.value = false;
  }

  function keepAlive(): void {
    clearTimer(watchdog);
    watchdog = setTimer(endDrag, DRAG_IDLE_MS);
  }

  function onDragEnter(event: Event): void {
    if (!carriesFiles((event as DragEvent).dataTransfer)) return;
    event.preventDefault();
    depth++;
    dragActive.value = true;
    keepAlive();
  }

  function onDragOver(event: Event): void {
    const transfer = (event as DragEvent).dataTransfer;
    if (!carriesFiles(transfer)) return;
    // Without this the page is not a drop target and the browser would open the file instead.
    event.preventDefault();
    try {
      transfer.dropEffect = 'copy';
    } catch {
      // Read-only in some browsers; only the cursor would differ.
    }
    dragActive.value = true;
    keepAlive();
  }

  function onDragLeave(event: Event): void {
    if (!carriesFiles((event as DragEvent).dataTransfer)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) endDrag();
  }

  /** Adds the PDFs inside dropped folders, however deep, and says so when that is not all. */
  async function addFolders(
    folders: readonly FileSystemDirectoryEntry[],
    source: FileSource,
  ): Promise<void> {
    const found = await readFolders(folders, env.folderLimits ?? FOLDER_LIMITS);
    if (found.files.length > 0) env.addFiles(found.files, source);
    if (found.truncated) env.notify?.({ key: 'toast.folderLimit' }, 'neutral');
    else if (found.files.length > 0) return;
    else if (found.unreadable) env.notify?.({ key: 'toast.folderUnreadable' }, 'error');
    else env.notify?.({ key: 'toast.folderEmpty' }, 'error');
  }

  /** Where the browser cannot tell folders from files: whatever can be read is a file. */
  async function addReadable(candidates: readonly File[], source: FileSource): Promise<void> {
    const readable = await Promise.all(candidates.map(isReadable));
    const files = candidates.filter((_, index) => readable[index]);
    if (files.length > 0) env.addFiles(files, source);
    if (files.length < candidates.length) {
      env.notify?.({ key: 'toast.folderUnreadable' }, 'error');
    }
  }

  function take(transfer: DataTransfer, source: FileSource): void {
    const { files, folders, unsorted } = sortTransfer(transfer);
    // Files first and at once; reading folders takes a moment.
    if (files.length > 0) env.addFiles(files, source);
    if (folders.length > 0) void addFolders(folders, source);
    if (unsorted.length > 0) void addReadable(unsorted, source);
  }

  function onDrop(event: Event): void {
    const transfer = (event as DragEvent).dataTransfer;
    if (!carriesFiles(transfer)) return;
    event.preventDefault();
    endDrag();
    take(transfer, 'drop');
  }

  function onPaste(event: Event): void {
    const transfer = (event as ClipboardEvent).clipboardData;
    // Pasted text (a password, say) carries no files and is none of our business.
    if (!transfer || filesFromTransfer(transfer).length === 0) return;
    event.preventDefault();
    take(transfer, 'paste');
  }

  const handlers: Record<(typeof DRAG_EVENTS)[number], (event: Event) => void> = {
    dragenter: onDragEnter,
    dragover: onDragOver,
    dragleave: onDragLeave,
    drop: onDrop,
    paste: onPaste,
  };

  return {
    dragActive,
    pickFiles() {
      env.openPicker?.((files) => {
        if (files.length > 0) env.addFiles(files, 'picker');
      });
    },
    attach() {
      const { target } = env;
      if (!target) return () => undefined;
      for (const type of DRAG_EVENTS) target.addEventListener(type, handlers[type]);
      return () => {
        for (const type of DRAG_EVENTS) target.removeEventListener(type, handlers[type]);
        endDrag();
      };
    },
  };
}

let pickerInput: HTMLInputElement | undefined;

/** The system file picker through a temporary `<input type="file">`. */
export function openPdfPicker(onFiles: (files: File[]) => void): void {
  // Left behind where a dismissed picker fires no event at all.
  pickerInput?.remove();
  const input = document.createElement('input');
  pickerInput = input;
  input.type = 'file';
  input.accept = 'application/pdf,.pdf';
  input.multiple = true;
  input.hidden = true;
  const finish = (): void => {
    const files = Array.from(input.files ?? []);
    input.remove();
    onFiles(files);
  };
  input.addEventListener('change', finish, { once: true });
  input.addEventListener('cancel', finish, { once: true });
  // Attached, because some browsers do not report the choice of a detached input.
  document.body.appendChild(input);
  input.click();
}
