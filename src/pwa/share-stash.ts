/**
 * Hand-over point for files shared into the app (Web Share Target).
 *
 * The share arrives as a POST navigation that only the service worker sees. The worker parks the
 * files in Cache Storage and redirects to the app; the page collects them from there. Cache
 * Storage is used because both sides can reach it without talking to each other, so the hand-over
 * also works while the page is not (yet) controlled by the worker, and because it keeps large
 * files on disk instead of in memory.
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

export const STASH_CACHE = 'pdfkey-incoming-v1';
/**
 * Files nobody collected within this time are discarded instead of popping up in some later,
 * unrelated session. Collection normally happens within seconds.
 */
export const STASH_MAX_AGE_MS = 15 * 60 * 1000;

const ENTRY_PREFIX = '__pdfkey-incoming__/';
const HEADER_NAME = 'X-PDFKey-Name';
const HEADER_MODIFIED = 'X-PDFKey-Modified';
const HEADER_RECEIVED = 'X-PDFKey-Received';

interface EntryKey {
  batch: string;
  index: number;
}

function parseEntryUrl(url: string): EntryKey | null {
  const match = /\/__pdfkey-incoming__\/([^/]+)\/(\d+)$/.exec(new URL(url).pathname);
  return match ? { batch: match[1]!, index: Number(match[2]) } : null;
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
): Promise<void> {
  if (files.length === 0) return;
  const cache = await storage.open(STASH_CACHE);
  // Zero-padded time first: batches sort in arrival order.
  const batch = `${String(now).padStart(15, '0')}-${randomId()}`;
  await Promise.all(
    files.map((file, index) =>
      cache.put(
        new URL(`${ENTRY_PREFIX}${batch}/${index}`, scope).href,
        new Response(file, {
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'Content-Length': String(file.size),
            // Header values are Latin-1 only; names are anything.
            [HEADER_NAME]: encodeURIComponent(file.name),
            [HEADER_MODIFIED]: String(file.lastModified),
            [HEADER_RECEIVED]: String(now),
          },
        }),
      ),
    ),
  );
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

/**
 * Removes and returns all stashed batches that belong to `scope`, oldest first. Stale entries are
 * deleted without being returned. Safe to call from several tabs at once: a file is handed to the
 * one caller whose delete succeeds, so every batch is delivered exactly once.
 */
export async function takeStashedFiles(
  storage: CacheStorage,
  scope: string,
  now = Date.now(),
): Promise<File[][]> {
  if (!(await storage.has(STASH_CACHE))) return [];
  const cache = await storage.open(STASH_CACHE);
  const prefix = new URL(ENTRY_PREFIX, scope).href;
  const batches = new Map<string, { index: number; file: File }[]>();

  for (const request of await cache.keys()) {
    if (!request.url.startsWith(prefix)) continue;
    const key = parseEntryUrl(request.url);
    const response = await cache.match(request);
    if (!key || !response || isStale(response, now)) {
      await cache.delete(request);
      continue;
    }
    // Read first, claim second: if the tab dies in between, the file is still there for another.
    const blob = await response.blob();
    if (!(await cache.delete(request))) continue;
    const modified = Number(response.headers.get(HEADER_MODIFIED));
    const file = new File([blob], decodeName(response.headers.get(HEADER_NAME)), {
      type: response.headers.get('Content-Type') ?? '',
      lastModified: Number.isFinite(modified) && modified > 0 ? modified : now,
    });
    const list = batches.get(key.batch);
    if (list) list.push({ index: key.index, file });
    else batches.set(key.batch, [{ index: key.index, file }]);
  }

  return [...batches.keys()].sort().map((batch) =>
    batches
      .get(batch)!
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.file),
  );
}

/** Deletes stale entries of every scope. Called by the service worker when it starts up. */
export async function purgeStaleStash(storage: CacheStorage, now = Date.now()): Promise<void> {
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
