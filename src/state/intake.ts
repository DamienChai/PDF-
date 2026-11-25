/**
 * The ways files get into the app from the page itself: the system file picker, drag and drop
 * onto the window, and paste. (Files shared to or opened with the installed app arrive through
 * src/pwa/incoming.ts and are wired up in app.ts.)
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import type { FileSource } from './jobs';

export interface Intake {
  /** Files are being dragged over the window: show the drop overlay. */
  readonly dragActive: ReadonlySignal<boolean>;
  /** Opens the system file picker for PDFs. Call it directly from a click handler. */
  pickFiles(): void;
  /**
   * Listens for drag and drop and paste on the window from now on. Dropping a file anywhere on
   * the page adds it (and never navigates away to it). Returns a function that stops listening.
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

/** The files of a drop or paste. Folders and non-file items are not included. */
export function filesFromTransfer(transfer: DataTransfer | null | undefined): File[] {
  return transfer?.files ? Array.from(transfer.files) : [];
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

  function onDrop(event: Event): void {
    const transfer = (event as DragEvent).dataTransfer;
    if (!carriesFiles(transfer)) return;
    event.preventDefault();
    endDrag();
    const files = filesFromTransfer(transfer);
    if (files.length > 0) env.addFiles(files, 'drop');
  }

  function onPaste(event: Event): void {
    const files = filesFromTransfer((event as ClipboardEvent).clipboardData);
    // Pasted text (a password, say) carries no files and is none of our business.
    if (files.length === 0) return;
    event.preventDefault();
    env.addFiles(files, 'paste');
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
