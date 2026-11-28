/**
 * Files of earlier builds, kept for the windows that still run them.
 *
 * A window that is open when a new version takes over keeps running the code it loaded, and
 * that code may ask later for more files of its own build: another engine worker, the
 * WebAssembly module, a chunk that is loaded on demand. The names of those files carry a hash
 * of their content, so the new version has no such file, neither in its precache nor on the
 * server. The worker of the new version therefore keeps what the build before it had and it has
 * not, and answers requests for those files from there.
 *
 * This module is used by the service worker and must not touch `window` or `self`.
 */

const CACHE_PREFIX = 'pdfkey-previous-builds-';
/**
 * A kept file is dropped this long after its build was replaced. Normally all of them go much
 * earlier, when a version takes over with no window open; this bounds what collects on a device
 * whose windows are never all closed.
 */
export const PREVIOUS_BUILD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** When the file's build was replaced, in milliseconds since the epoch. */
const HEADER_RETIRED = 'X-PDFKey-Retired';
/**
 * Workbox adds this parameter to the precache key of a file whose name carries no hash. Such a
 * file has the same address in every build; the new one answers for it.
 */
const REVISION_PARAM = '__WB_REVISION__';

/**
 * One cache per copy of the app: several can live on one origin (GitHub Pages project sites).
 */
export function previousBuildsCache(scope: string): string {
  return `${CACHE_PREFIX}${scope}`;
}

/**
 * Copies from the precache every file that the build being installed does not have. Call it
 * while the new version installs: the precache is then still that of the running version; and
 * call it when the files of the new version are stored, so that on a device that is nearly full
 * the room goes to them. `inNewBuild` says whether the new build has a file at an address.
 * Returns the number of files kept. If a copy cannot be stored, the copies of this call are
 * taken back and the error is passed on: half a build is of no use, and the room is.
 */
export async function keepPreviousBuild(
  storage: CacheStorage,
  scope: string,
  precacheName: string,
  inNewBuild: (url: string) => boolean,
  now = Date.now(),
): Promise<number> {
  if (!(await storage.has(precacheName))) return 0;
  const precache = await storage.open(precacheName);
  const superseded = (await precache.keys()).filter(
    (request) =>
      request.url.startsWith(scope) &&
      !new URL(request.url).searchParams.has(REVISION_PARAM) &&
      !inNewBuild(request.url),
  );
  if (superseded.length === 0) return 0;
  const name = previousBuildsCache(scope);
  const kept = await storage.open(name);
  const copied: Request[] = [];
  try {
    for (const request of superseded) {
      const response = await precache.match(request);
      if (!response) continue;
      const headers = new Headers(response.headers);
      headers.set(HEADER_RETIRED, String(now));
      copied.push(request);
      await kept.put(
        request,
        new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        }),
      );
    }
  } catch (error) {
    await Promise.all(copied.map((request) => kept.delete(request).catch(() => false)));
    if ((await kept.keys()).length === 0) await storage.delete(name);
    throw error;
  }
  return copied.length;
}

/** The kept file of an earlier build that answers `request`, if there is one. */
export async function matchPreviousBuild(
  storage: CacheStorage,
  scope: string,
  request: Request,
): Promise<Response | undefined> {
  const name = previousBuildsCache(scope);
  if (!(await storage.has(name))) return undefined;
  return (await storage.open(name)).match(request);
}

/**
 * Drops kept files that nothing can ask for any more. `windows` is the number of windows of the
 * app that may run an earlier build; without one there is no old code left. Call it
 *
 * - when a version takes over, with every window that is open;
 * - when a page has loaded, with the windows other than that one and with `inRunningBuild`,
 *   which says whether an address belongs to the build of the worker that served the page. The
 *   page runs that build. If it is alone, only files of that build can still be asked for:
 *   those that a version which is installing or waiting has set aside for this very page.
 */
export async function prunePreviousBuilds(
  storage: CacheStorage,
  scope: string,
  windows: number,
  now = Date.now(),
  inRunningBuild?: (url: string) => boolean,
): Promise<void> {
  const name = previousBuildsCache(scope);
  if (!(await storage.has(name))) return;
  if (windows === 0 && !inRunningBuild) {
    await storage.delete(name);
    return;
  }
  const kept = await storage.open(name);
  const requests = await kept.keys();
  let left = requests.length;
  for (const request of requests) {
    const retired = Number((await kept.match(request))?.headers.get(HEADER_RETIRED));
    const young = Number.isFinite(retired) && now - retired <= PREVIOUS_BUILD_MAX_AGE_MS;
    if (young && (windows > 0 || inRunningBuild?.(request.url))) continue;
    await kept.delete(request);
    left--;
  }
  if (left === 0) await storage.delete(name);
}
