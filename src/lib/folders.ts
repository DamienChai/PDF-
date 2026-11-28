/**
 * Folders dropped onto the page: finds the PDFs inside, at any depth.
 *
 * A dropped folder arrives as a `FileSystemDirectoryEntry` (`DataTransferItem.webkitGetAsEntry()`
 * in Chrome, Edge, Safari and Firefox). Its `File` object is useless: it has a name and a size,
 * but reading it fails.
 */

export interface FolderLimits {
  /** PDFs taken from the folders of one drop. */
  maxFiles: number;
  /** Entries of any kind that are looked at; bounds the walk through a folder full of other things. */
  maxEntries: number;
  /** Levels read, the dropped folder being the first. */
  maxDepth: number;
}

/**
 * Generous for a folder of documents, and small enough that dropping a whole disk by accident
 * ends quickly.
 */
export const FOLDER_LIMITS: FolderLimits = { maxFiles: 500, maxEntries: 10_000, maxDepth: 8 };

export interface FolderContents {
  /** The PDFs: folder by folder, each in the order of its names. */
  files: File[];
  /** A limit was reached; there may be more PDFs than `files`. */
  truncated: boolean;
  /** A folder (or a file in one) could not be read. */
  unreadable: boolean;
}

/** PDFs are picked by name here; whether a file really is one is decided by its content later. */
function hasPdfName(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/** `.DS_Store`, `.git`, and the `._name.pdf` companions macOS leaves on foreign disks. */
function isHidden(name: string): boolean {
  return name.startsWith('.');
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Up to `room` entries of a directory; `more` if it has others. */
function list(
  directory: FileSystemDirectoryEntry,
  room: number,
): Promise<{ entries: FileSystemEntry[]; more: boolean }> {
  const reader = directory.createReader();
  const entries: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    // A reader hands out its entries in batches and ends with an empty one.
    const next = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve({ entries, more: false });
        } else if (entries.length + batch.length > room) {
          entries.push(...batch.slice(0, room - entries.length));
          resolve({ entries, more: true });
        } else {
          entries.push(...batch);
          next();
        }
      }, reject);
    };
    next();
  });
}

/**
 * Collects the PDFs of dropped folders. Other files are passed over, and so is everything
 * hidden. Never rejects: what cannot be read is left out and reported in the result.
 */
export async function readFolders(
  folders: readonly FileSystemDirectoryEntry[],
  limits: FolderLimits = FOLDER_LIMITS,
): Promise<FolderContents> {
  const result: FolderContents = { files: [], truncated: false, unreadable: false };
  let seen = 0;
  /** A limit on the number of files or entries was reached: nothing more is read. */
  let full = false;

  async function walk(directory: FileSystemDirectoryEntry, depth: number): Promise<void> {
    let listed: { entries: FileSystemEntry[]; more: boolean };
    try {
      listed = await list(directory, limits.maxEntries - seen);
    } catch {
      result.unreadable = true;
      return;
    }
    seen += listed.entries.length;
    const entries = listed.entries
      .filter((entry) => !isHidden(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of entries) {
      if (full) return;
      if (entry.isDirectory) {
        if (depth >= limits.maxDepth) result.truncated = true;
        else await walk(entry as FileSystemDirectoryEntry, depth + 1);
      } else if (entry.isFile && hasPdfName(entry.name)) {
        if (result.files.length >= limits.maxFiles) {
          full = true;
          break;
        }
        try {
          result.files.push(await fileOf(entry as FileSystemFileEntry));
        } catch {
          // Deleted or locked since the folder was listed.
          result.unreadable = true;
        }
      }
    }
    if (listed.more) full = true;
    if (full) result.truncated = true;
  }

  for (const folder of folders) {
    if (full) break;
    await walk(folder, 1);
  }
  return result;
}
