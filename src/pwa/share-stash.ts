/**
 * Hand-over point for files shared into the app (Web Share Target).
 *
 * The share arrives as a POST navigation that only the service worker sees. The worker parks the
 * files in Cache Storage and redirects to the app; the page collects them from there. Cache
 * Storage is used because both sides can reach it without talking to each other, so the hand-over
 * also works while the page is not (yet) controlled by the worker, and because it keeps large
 * files on disk instead of in memory.
 *
 * A file is parked in slices, one cache entry each, because browsers limit the size of a single
 * entry (Chromium: 256 MiB). The page puts the slices together again; no slice is ever copied
 * into memory for that.
 *
 * The files of one share are a batch, and a batch changes hands as a whole: the worker marks it
 * complete when its last file is parked, and until then no page touches it. A page that looks
 * while a large share is still being written therefore takes nothing of it, rather than the
 * files that happen to be finished.
 *
 * This module is shared by the service worker and the page and must not touch `window` or `self`.
 */

/** Path of the share target, relative to the app's scope. Repeated in vite.config.ts (manifest). */
export const SHARE_TARGET_PATH = 'share-target';
/** Name of the form field the shared files arrive in (any file field is accepted on arrival). */
export const SHARE_FILES_FIELD = 'pdfs';
/** Where the worker sends the browser after stashing; relative to the app's scope. */
export const SHARE_REDIRECT = './?source=share-target';
export const SHARE_SOURCE_PARAM = 'source';
export const SHARE_SOURCE_VALUE = 'share-target';
/**
 * Added to the redirect when files of the share could not be parked: their number, or
 * `SHARE_LOST_ALL` when the share could not be read at all.
 */
export const SHARE_LOST_PARAM = 'lost';
export const SHARE_LOST_ALL = 'all';

export const STASH_CACHE = 'pdfkey-incoming-v3';
/** Caches of earlier layouts; whatever is left in them is of no use to this version. */
const RETIRED_STASH_CACHES = ['pdfkey-incoming-v1', 'pdfkey-incoming-v2'];
/** Size of the slices a file is parked in: far below every browser's limit for one entry. */
export const STASH_SLICE_BYTES = 64 * 1024 * 1024;
/**
 * Files nobody collected within this time are discarded instead of popping up in some later,
 * unrelated session. Collection normally happens within seconds.
 */
export const STASH_MAX_AGE_MS = 15 * 60 * 1000;

const ENTRY_PREFIX = '__pdfkey-incoming__/';
const HEADER_NAME = 'X-PDFKey-Name';
const HEADER_MODIFIED = 'X-PDFKey-Modified';
const HEADER_RECEIVED = 'X-PDFKey-Received';
/** Number of slices the file consists of; on every one of them. */
const HEADER_SLICES = 'X-PDFKey-Slices';

/** Last part of the entry that marks a batch as complete. */
const COMPLETE_MARK = 'complete';

interface EntryKey {
  batch: string;
  /** The slice of a file the entry holds; null for the entry that marks the batch complete. */
  part: {
    /** Position of the file in its batch. */
    index: number;
    /** Position of the slice in its file. */
    slice: number;
  } | null;
}

function parseEntryUrl(url: string): EntryKey | null {
  const match = /\/__pdfkey-incoming__\/([^/]+)\/(?:(\d+)\/(\d+)|complete)$/.exec(
    new URL(url).pathname,
  );
  if (!match) return null;
  const part = match[2] === undefined ? null : { index: Number(match[2]), slice: Number(match[3]) };
  return { batch: match[1]!, part };
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Extracts the uploaded files from a share-target form, whatever the field is called. */
export function filesFromForm(form: FormData): File[] {
  const files: File[] = [];
  for (const value of form.values()) {
    // A file field that was left empty arrives as a nameless, empty File.
    if (value instanceof File && !(value.size === 0 && value.name === '')) files.push(value);
  }
  return files;
}

/** The address the worker redirects to after a share of which `lost` files could not be parked. */
export function shareRedirect(lost: number | typeof SHARE_LOST_ALL): string {
  return lost === 0 ? SHARE_REDIRECT : `${SHARE_REDIRECT}&${SHARE_LOST_PARAM}=${lost}`;
}

/**
 * What an address says about lost files of a share: their number, `SHARE_LOST_ALL`, or null for
 * an address that reports none.
 */
export function lostInShare(url: URL): number | typeof SHARE_LOST_ALL | null {
  if (url.searchParams.get(SHARE_SOURCE_PARAM) !== SHARE_SOURCE_VALUE) return null;
  const value = url.searchParams.get(SHARE_LOST_PARAM);
  if (value === null) return null;
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : SHARE_LOST_ALL;
}

export interface StashReport {
  /** Files that are parked completely. */
  stored: number;
  /** Files that could not be parked (storage full, …); nothing of them is left behind. */
  failed: number;
}

/**
 * Stores one shared batch. Called by the service worker.
 * `scope` is the app's base URL; entries live under it so that several copies of the app on one
 * origin (GitHub Pages project sites) do not see each other's files.
 */
export async function stashFiles(
  storage: CacheStorage,
  scope: string,
  files: readonly File[],
  now = Date.now(),
  sliceBytes = STASH_SLICE_BYTES,
): Promise<StashReport> {
  const report: StashReport = { stored: 0, failed: 0 };
  if (files.length === 0) return report;
  const cache = await storage.open(STASH_CACHE);
  // Zero-padded time first: batches sort in arrival order.
  const batch = `${String(now).padStart(15, '0')}-${randomId()}`;
  const parked: string[] = [];
  // One after the other: several large files written at once would only compete for the disk.
  for (const [index, file] of files.entries()) {
    const slices = Math.max(1, Math.ceil(file.size / sliceBytes));
    const written: string[] = [];
    try {
      for (let slice = 0; slice < slices; slice++) {
        const url = new URL(`${ENTRY_PREFIX}${batch}/${index}/${slice}`, scope).href;
        const body = file.slice(slice * sliceBytes, (slice + 1) * sliceBytes);
        written.push(url);
        await cache.put(
          url,
          new Response(body, {
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
              'Content-Length': String(body.size),
              // Header values are Latin-1 only; names are anything.
              [HEADER_NAME]: encodeURIComponent(file.name),
              [HEADER_MODIFIED]: String(file.lastModified),
              [HEADER_RECEIVED]: String(now),
              [HEADER_SLICES]: String(slices),
            },
          }),
        );
      }
      report.stored++;
      parked.push(...written);
    } catch {
      report.failed++;
      // Half a file is of no use to anybody.
      await Promise.all(written.map((url) => cache.delete(url).catch(() => false)));
    }
  }
  if (report.stored === 0) return report;
  try {
    // Last of all: from now on the batch is there to be collected.
    await cache.put(
      new URL(`${ENTRY_PREFIX}${batch}/${COMPLETE_MARK}`, scope).href,
      new Response(null, { headers: { [HEADER_RECEIVED]: String(now) } }),
    );
  } catch {
    // Without its mark nobody would ever collect the batch.
    await Promise.all(parked.map((url) => cache.delete(url).catch(() => false)));
    return { stored: 0, failed: files.length };
  }
  return report;
}

function isStale(response: Response, now: number): boolean {
  const received = Number(response.headers.get(HEADER_RECEIVED));
  // Entries from the future (clock changes) are treated like fresh ones until they age out.
  return !Number.isFinite(received) || now - received > STASH_MAX_AGE_MS;
}

function decodeName(encoded: string | null): string {
  if (!encoded) return 'document.pdf';
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

interface StashedSlice {
  request: Request;
  response: Response;
  slice: number;
}

interface StashedBatch {
  /** The entry that marks the batch complete, once the worker has written it. */
  mark: Request | null;
  /** Position in the batch → the slices of that file. */
  files: Map<number, StashedSlice[]>;
}

/**
 * Removes and returns all complete batches that belong to `scope`, oldest first. Stale entries
 * are deleted without being returned, and a batch the worker is still writing is left alone,
 * whatever of it is there already. Safe to call from several tabs at once: a batch is handed to
 * the one caller who manages to delete its mark, so every share arrives exactly once and in
 * one piece.
 */
export async function takeStashedFiles(
  storage: CacheStorage,
  scope: string,
  now = Date.now(),
): Promise<File[][]> {
  if (!(await storage.has(STASH_CACHE))) return [];
  const cache = await storage.open(STASH_CACHE);
  const prefix = new URL(ENTRY_PREFIX, scope).href;
  const stashed = new Map<string, StashedBatch>();

  for (const request of await cache.keys()) {
    if (!request.url.startsWith(prefix)) continue;
    const key = parseEntryUrl(request.url);
    const response = await cache.match(request);
    if (!key || !response || isStale(response, now)) {
      await cache.delete(request);
      continue;
    }
    let batch = stashed.get(key.batch);
    if (!batch) stashed.set(key.batch, (batch = { mark: null, files: new Map() }));
    if (!key.part) {
      batch.mark = request;
      continue;
    }
    const slices = batch.files.get(key.part.index);
    const found = { request, response, slice: key.part.slice };
    if (slices) slices.push(found);
    else batch.files.set(key.part.index, [found]);
  }

  const batches: File[][] = [];
  for (const name of [...stashed.keys()].sort()) {
    const { mark, files: positions } = stashed.get(name)!;
    if (!mark) continue;
    const whole: { slices: StashedSlice[]; blobs: Blob[] }[] = [];
    for (const index of [...positions.keys()].sort((a, b) => a - b)) {
      const slices = positions.get(index)!.sort((a, b) => a.slice - b.slice);
      const expected = Number(slices[0]!.response.headers.get(HEADER_SLICES) ?? 1);
      if (slices.length !== expected || slices.some((entry, at) => entry.slice !== at)) continue;
      whole.push({
        slices,
        blobs: await Promise.all(slices.map((entry) => entry.response.blob())),
      });
    }
    // Read first, claim second: if the tab dies in between, the batch is still there for another.
    if (!(await cache.delete(mark))) continue;
    await Promise.all(
      [...positions.values()].flat().map((entry) => cache.delete(entry.request).catch(() => false)),
    );
    const files = whole.map(({ slices, blobs }) => {
      const { headers } = slices[0]!.response;
      const modified = Number(headers.get(HEADER_MODIFIED));
      return new File(blobs, decodeName(headers.get(HEADER_NAME)), {
        type: headers.get('Content-Type') ?? '',
        lastModified: Number.isFinite(modified) && modified > 0 ? modified : now,
      });
    });
    if (files.length > 0) batches.push(files);
  }
  return batches;
}

/**
 * Deletes stale entries of every scope, and the caches of earlier layouts. Called by the service
 * worker when a version takes over; between versions a page drops the stale entries of its own
 * scope each time it looks for shared files, which is every time the app is opened.
 */
export async function purgeStaleStash(storage: CacheStorage, now = Date.now()): Promise<void> {
  await Promise.all(RETIRED_STASH_CACHES.map((name) => storage.delete(name)));
  if (!(await storage.has(STASH_CACHE))) return;
  const cache = await storage.open(STASH_CACHE);
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    if (!response || isStale(response, now)) await cache.delete(request);
  }
}

/** True for the POST the browser sends when the user shares files to the installed app. */
export function isShareTargetUrl(url: string, scope: string): boolean {
  const target = new URL(SHARE_TARGET_PATH, scope);
  const actual = new URL(url);
  return actual.origin === target.origin && actual.pathname === target.pathname;
}
