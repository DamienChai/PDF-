import { describe, expect, it } from 'vitest';
import {
  PREVIOUS_BUILD_MAX_AGE_MS,
  keepPreviousBuild,
  matchPreviousBuild,
  previousBuildsCache,
  prunePreviousBuilds,
} from './previous-builds';
import { memoryCacheStorage } from './testing';

const SCOPE = 'https://user.github.io/PDF-/';
const PRECACHE = `workbox-precache-v2-${SCOPE}`;

/** A precache as Workbox fills it: hashed files under their address, others with a revision. */
async function precacheOf(storage: CacheStorage, files: Record<string, string>): Promise<void> {
  const cache = await storage.open(PRECACHE);
  for (const [path, body] of Object.entries(files)) {
    const type = path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    await cache.put(`${SCOPE}${path}`, new Response(body, { headers: { 'Content-Type': type } }));
  }
}

const V1 = {
  'index.html?__WB_REVISION__=1': 'page 1',
  'assets/index-AAAA.js': 'app 1',
  'assets/worker-BBBB.js': 'worker 1',
  'assets/pdfx-CCCC.wasm': 'engine 1',
  'assets/index-DDDD.css': 'styles',
};
/** The addresses of a release that changed the app and the engine, and kept the styles. */
const V2 = new Set(
  ['index.html', 'assets/index-EEEE.js', 'assets/worker-FFFF.js', 'assets/pdfx-GGGG.wasm'].map(
    (path) => `${SCOPE}${path}`,
  ),
);
V2.add(`${SCOPE}assets/index-DDDD.css`);
const inV2 = (url: string): boolean => V2.has(url);

async function keptPaths(storage: CacheStorage): Promise<string[]> {
  if (!(await storage.has(previousBuildsCache(SCOPE)))) return [];
  const requests = await (await storage.open(previousBuildsCache(SCOPE))).keys();
  return requests.map((request) => request.url.slice(SCOPE.length)).sort();
}

describe('files of the previous build', () => {
  it('keeps what the new build does not have, and only that', async () => {
    const storage = memoryCacheStorage();
    await precacheOf(storage, V1);
    expect(await keepPreviousBuild(storage, SCOPE, PRECACHE, inV2, 1000)).toBe(3);
    // Not the page (same address in every build) and not the file both builds share.
    expect(await keptPaths(storage)).toEqual([
      'assets/index-AAAA.js',
      'assets/pdfx-CCCC.wasm',
      'assets/worker-BBBB.js',
    ]);
  });

  it('answers a request for such a file with its content and type', async () => {
    const storage = memoryCacheStorage();
    await precacheOf(storage, V1);
    await keepPreviousBuild(storage, SCOPE, PRECACHE, inV2, 1000);
    // The new version has taken over: the precache no longer has the old files.
    await storage.delete(PRECACHE);

    const worker = await matchPreviousBuild(
      storage,
      SCOPE,
      new Request(`${SCOPE}assets/worker-BBBB.js`),
    );
    expect(await worker!.text()).toBe('worker 1');
    expect(worker!.headers.get('Content-Type')).toBe('text/javascript');
    const engine = await matchPreviousBuild(
      storage,
      SCOPE,
      new Request(`${SCOPE}assets/pdfx-CCCC.wasm`),
    );
    expect(engine!.headers.get('Content-Type')).toBe('application/wasm');
    expect(
      await matchPreviousBuild(storage, SCOPE, new Request(`${SCOPE}assets/unknown.js`)),
    ).toBeUndefined();
  });

  it('does nothing on a first installation, and creates no cache by looking', async () => {
    const storage = memoryCacheStorage();
    expect(await keepPreviousBuild(storage, SCOPE, PRECACHE, inV2)).toBe(0);
    expect(await matchPreviousBuild(storage, SCOPE, new Request(`${SCOPE}a.js`))).toBeUndefined();
    await prunePreviousBuilds(storage, SCOPE, 1);
    expect(await storage.keys()).toEqual([]);
  });

  it('creates no cache when the new build has every file of the old one', async () => {
    const storage = memoryCacheStorage();
    await precacheOf(storage, V1);
    expect(await keepPreviousBuild(storage, SCOPE, PRECACHE, () => true)).toBe(0);
    expect(await storage.has(previousBuildsCache(SCOPE))).toBe(false);
  });

  it('keeps the files of several builds while windows are open', async () => {
    const storage = memoryCacheStorage();
    await precacheOf(storage, V1);
    await keepPreviousBuild(storage, SCOPE, PRECACHE, inV2, 1000);
    // Version 2 took over; version 3 replaces its worker.
    await storage.delete(PRECACHE);
    await precacheOf(storage, { 'assets/worker-FFFF.js': 'worker 2', 'assets/index-EEEE.js': '2' });
    await prunePreviousBuilds(storage, SCOPE, 2, 2000);
    await keepPreviousBuild(storage, SCOPE, PRECACHE, (url) => url.endsWith('index-EEEE.js'), 3000);
    expect(await keptPaths(storage)).toEqual([
      'assets/index-AAAA.js',
      'assets/pdfx-CCCC.wasm',
      'assets/worker-BBBB.js',
      'assets/worker-FFFF.js',
    ]);
  });

  it('drops everything when a version takes over with no window open', async () => {
    const storage = memoryCacheStorage();
    await precacheOf(storage, V1);
    await keepPreviousBuild(storage, SCOPE, PRECACHE, inV2, 1000);
    await prunePreviousBuilds(storage, SCOPE, 0, 1000);
    expect(await storage.has(previousBuildsCache(SCOPE))).toBe(false);
  });

  it('drops a file a month after its build was replaced, windows or not', async () => {
    const storage = memoryCacheStorage();
    await precacheOf(storage, V1);
    await keepPreviousBuild(storage, SCOPE, PRECACHE, inV2, 1000);
    await storage.delete(PRECACHE);
    await precacheOf(storage, { 'assets/worker-FFFF.js': 'worker 2' });
    const later = 1000 + PREVIOUS_BUILD_MAX_AGE_MS;
    await keepPreviousBuild(storage, SCOPE, PRECACHE, () => false, later);

    await prunePreviousBuilds(storage, SCOPE, 1, later);
    expect(await keptPaths(storage)).toHaveLength(4);
    await prunePreviousBuilds(storage, SCOPE, 1, later + 1);
    expect(await keptPaths(storage)).toEqual(['assets/worker-FFFF.js']);
    await prunePreviousBuilds(storage, SCOPE, 1, later + 1 + PREVIOUS_BUILD_MAX_AGE_MS);
    expect(await storage.has(previousBuildsCache(SCOPE))).toBe(false);
  });

  it('a page that has loaded alone leaves only what was set aside for its own build', async () => {
    const storage = memoryCacheStorage();
    await precacheOf(storage, V1);
    await keepPreviousBuild(storage, SCOPE, PRECACHE, inV2, 1000);
    // Version 2 runs; version 3 has installed and waits, with a file of version 2 set aside.
    await storage.delete(PRECACHE);
    await precacheOf(storage, { 'assets/worker-FFFF.js': 'worker 2', 'assets/index-EEEE.js': '2' });
    await keepPreviousBuild(storage, SCOPE, PRECACHE, (url) => url.endsWith('index-EEEE.js'), 3000);
    expect(await keptPaths(storage)).toHaveLength(4);

    // Another window is open: it may run version 1.
    await prunePreviousBuilds(storage, SCOPE, 1, 4000, inV2);
    expect(await keptPaths(storage)).toHaveLength(4);
    // Alone: nothing runs version 1 any more; the page itself runs version 2.
    await prunePreviousBuilds(storage, SCOPE, 0, 4000, inV2);
    expect(await keptPaths(storage)).toEqual(['assets/worker-FFFF.js']);
    // Not for ever either.
    await prunePreviousBuilds(storage, SCOPE, 0, 3001 + PREVIOUS_BUILD_MAX_AGE_MS, inV2);
    expect(await storage.has(previousBuildsCache(SCOPE))).toBe(false);
  });

  it('a page that has loaded alone after an update leaves nothing behind', async () => {
    const storage = memoryCacheStorage();
    await precacheOf(storage, V1);
    await keepPreviousBuild(storage, SCOPE, PRECACHE, inV2, 1000);
    await prunePreviousBuilds(storage, SCOPE, 0, 2000, inV2);
    expect(await storage.has(previousBuildsCache(SCOPE))).toBe(false);
  });

  it('takes back the copies of an attempt that ran out of room', async () => {
    const storage = memoryCacheStorage();
    await precacheOf(storage, V1);
    const kept = await storage.open(previousBuildsCache(SCOPE));
    await kept.put(`${SCOPE}assets/older-0000.js`, new Response('kept before'));
    const put = kept.put.bind(kept);
    let room = 1;
    // The cache storage hands out one object per cache: the copy below meets this one.
    kept.put = async (request, response) => {
      if (room-- <= 0) throw new DOMException('full', 'QuotaExceededError');
      return put(request, response);
    };
    await expect(keepPreviousBuild(storage, SCOPE, PRECACHE, inV2, 1000)).rejects.toThrow('full');
    // What an earlier update set aside is untouched; nothing of this one is left.
    expect(await keptPaths(storage)).toEqual(['assets/older-0000.js']);

    // With nothing else in it, the cache goes as well.
    await kept.delete(`${SCOPE}assets/older-0000.js`);
    room = 2;
    await expect(keepPreviousBuild(storage, SCOPE, PRECACHE, inV2, 1000)).rejects.toThrow('full');
    expect(await storage.has(previousBuildsCache(SCOPE))).toBe(false);
  });

  it('keeps the copies of the app on one origin apart', async () => {
    const storage = memoryCacheStorage();
    const other = 'https://user.github.io/other/';
    await precacheOf(storage, V1);
    await keepPreviousBuild(storage, SCOPE, PRECACHE, inV2, 1000);
    expect(
      await matchPreviousBuild(storage, other, new Request(`${SCOPE}assets/worker-BBBB.js`)),
    ).toBeUndefined();
    await prunePreviousBuilds(storage, other, 0);
    expect(await keptPaths(storage)).toHaveLength(3);
  });
});
