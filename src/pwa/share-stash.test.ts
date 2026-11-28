import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SHARE_FILES_FIELD,
  SHARE_LOST_ALL,
  SHARE_REDIRECT,
  SHARE_TARGET_PATH,
  STASH_CACHE,
  STASH_MAX_AGE_MS,
  STASH_SLICE_BYTES,
  filesFromForm,
  isShareTargetUrl,
  lostInShare,
  purgeStaleStash,
  shareRedirect,
  stashFiles,
  takeStashedFiles,
} from './share-stash';
import { memoryCacheStorage } from './testing';

const SCOPE = 'https://user.github.io/PDF-/';

function pdf(name: string, content = name, lastModified = 1_700_000_000_000): File {
  return new File([`%PDF-1.7 ${content}`], name, { type: 'application/pdf', lastModified });
}

async function entryCount(storage: CacheStorage): Promise<number> {
  return (await (await storage.open(STASH_CACHE)).keys()).length;
}

/** The stashed entries below their batch: "file/slice", and "complete" for the batch's mark. */
async function entryPaths(storage: CacheStorage): Promise<string[]> {
  const requests = await (await storage.open(STASH_CACHE)).keys();
  return requests
    .map((request) => request.url.split('/'))
    .map((parts) => (parts.at(-1) === 'complete' ? 'complete' : parts.slice(-2).join('/')))
    .sort();
}

/** A storage whose stash refuses the entries `refuses` picks, the way a full disk would. */
function storageRefusing(refuses: (url: string) => boolean): CacheStorage {
  const storage = memoryCacheStorage();
  const open = storage.open.bind(storage);
  storage.open = async (name) => {
    const cache = await open(name);
    const put = cache.put.bind(cache);
    cache.put = async (request, response) => {
      if (refuses(String(request))) throw new DOMException('disk full', 'QuotaExceededError');
      return put(request, response);
    };
    return cache;
  };
  return storage;
}

describe('share stash', () => {
  it('hands over name, type, modification time and content', async () => {
    const storage = memoryCacheStorage();
    const original = pdf('合同 (final) 100%.pdf', 'body', 1_650_000_000_123);
    await stashFiles(storage, SCOPE, [original]);

    const batches = await takeStashedFiles(storage, SCOPE);
    expect(batches).toHaveLength(1);
    const [file] = batches[0]!;
    expect(file).toBeInstanceOf(File);
    expect(file!.name).toBe('合同 (final) 100%.pdf');
    expect(file!.type).toBe('application/pdf');
    expect(file!.lastModified).toBe(1_650_000_000_123);
    expect(await file!.text()).toBe('%PDF-1.7 body');
  });

  it('keeps the files of a batch in order and batches in arrival order', async () => {
    const storage = memoryCacheStorage();
    const names = Array.from({ length: 12 }, (_, index) => `f${index}.pdf`);
    await stashFiles(
      storage,
      SCOPE,
      names.map((name) => pdf(name)),
      2000,
    );
    await stashFiles(storage, SCOPE, [pdf('earlier.pdf')], 1000);
    await stashFiles(storage, SCOPE, [pdf('later.pdf')], 3000);

    const batches = await takeStashedFiles(storage, SCOPE, 3000);
    expect(batches.map((batch) => batch.map((file) => file.name))).toEqual([
      ['earlier.pdf'],
      names,
      ['later.pdf'],
    ]);
  });

  it('delivers every batch exactly once', async () => {
    const storage = memoryCacheStorage();
    await stashFiles(storage, SCOPE, [pdf('a.pdf'), pdf('b.pdf')]);
    expect(await takeStashedFiles(storage, SCOPE)).toHaveLength(1);
    expect(await takeStashedFiles(storage, SCOPE)).toEqual([]);
    expect(await entryCount(storage)).toBe(0);
  });

  it('gives a share to only one of several tabs collecting at the same time, in one piece', async () => {
    const storage = memoryCacheStorage();
    await stashFiles(storage, SCOPE, [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    const results = await Promise.all([
      takeStashedFiles(storage, SCOPE),
      takeStashedFiles(storage, SCOPE),
      takeStashedFiles(storage, SCOPE),
    ]);
    const taken = results.filter((batches) => batches.length > 0);
    expect(taken).toHaveLength(1);
    expect(taken[0]!.flat().map((file) => file.name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(await entryCount(storage)).toBe(0);
  });

  it('hands over nothing of a share that is still being written', async () => {
    // A second collector looks each time the worker has parked another entry of the share.
    const storage = memoryCacheStorage();
    const seen: string[][] = [];
    const open = storage.open.bind(storage);
    storage.open = async (name) => {
      const cache = await open(name);
      const put = cache.put.bind(cache);
      return Object.assign(Object.create(cache) as Cache, {
        async put(request: RequestInfo | URL, response: Response): Promise<void> {
          await put(request, response);
          if (String(request).endsWith('/complete')) return;
          const early = await takeStashedFiles(storage, SCOPE, 1000);
          seen.push(early.flat().map((file) => file.name));
        },
      });
    };
    const files = [pdf('first.pdf'), pdf('second.pdf'), pdf('third.pdf')];
    expect(await stashFiles(storage, SCOPE, files, 1000)).toEqual({ stored: 3, failed: 0 });
    expect(seen).toEqual([[], [], []]);

    // Complete: all of it, to whoever comes next.
    const batches = await takeStashedFiles(storage, SCOPE, 1000);
    expect(batches.map((batch) => batch.map((file) => file.name))).toEqual([
      ['first.pdf', 'second.pdf', 'third.pdf'],
    ]);
  });

  it('discards stale files instead of delivering them', async () => {
    const storage = memoryCacheStorage();
    await stashFiles(storage, SCOPE, [pdf('old.pdf')], 1000);
    await stashFiles(storage, SCOPE, [pdf('fresh.pdf')], 1000 + STASH_MAX_AGE_MS);
    const batches = await takeStashedFiles(storage, SCOPE, 1001 + STASH_MAX_AGE_MS);
    expect(batches.flat().map((file) => file.name)).toEqual(['fresh.pdf']);
    expect(await entryCount(storage)).toBe(0);
  });

  it('accepts files at exactly the age limit', async () => {
    const storage = memoryCacheStorage();
    await stashFiles(storage, SCOPE, [pdf('edge.pdf')], 1000);
    expect(await takeStashedFiles(storage, SCOPE, 1000 + STASH_MAX_AGE_MS)).toHaveLength(1);
  });

  it('keeps app copies in different folders of one origin apart', async () => {
    const storage = memoryCacheStorage();
    const other = 'https://user.github.io/other-app/';
    await stashFiles(storage, SCOPE, [pdf('mine.pdf')]);
    await stashFiles(storage, other, [pdf('theirs.pdf')]);
    expect((await takeStashedFiles(storage, SCOPE)).flat().map((file) => file.name)).toEqual([
      'mine.pdf',
    ]);
    expect((await takeStashedFiles(storage, other)).flat().map((file) => file.name)).toEqual([
      'theirs.pdf',
    ]);
  });

  it('does nothing for an empty share and creates no cache when reading', async () => {
    const storage = memoryCacheStorage();
    await stashFiles(storage, SCOPE, []);
    expect(await storage.has(STASH_CACHE)).toBe(false);
    expect(await takeStashedFiles(storage, SCOPE)).toEqual([]);
    expect(await storage.has(STASH_CACHE)).toBe(false);
  });

  it('falls back to sensible metadata for foreign entries', async () => {
    const storage = memoryCacheStorage();
    const cache = await storage.open(STASH_CACHE);
    await cache.put(
      `${SCOPE}__pdfkey-incoming__/000000000001000-ab/0/0`,
      new Response('x', { headers: { 'X-PDFKey-Received': '1000' } }),
    );
    await cache.put(
      `${SCOPE}__pdfkey-incoming__/000000000001000-ab/complete`,
      new Response(null, { headers: { 'X-PDFKey-Received': '1000' } }),
    );
    // The layout of an earlier version, one entry per file: not understood, not kept.
    await cache.put(
      `${SCOPE}__pdfkey-incoming__/000000000001000-cd/0`,
      new Response('z', { headers: { 'X-PDFKey-Received': '1000' } }),
    );
    await cache.put(`${SCOPE}__pdfkey-incoming__/garbage`, new Response('y'));
    const batches = await takeStashedFiles(storage, SCOPE, 2000);
    expect(batches).toHaveLength(1);
    expect(batches[0]![0]!.name).toBe('document.pdf');
    expect(batches[0]![0]!.lastModified).toBe(2000);
    expect(await entryCount(storage)).toBe(0);
  });

  it('purges stale entries of every scope', async () => {
    const storage = memoryCacheStorage();
    await stashFiles(storage, SCOPE, [pdf('old.pdf')], 0);
    await stashFiles(storage, 'https://user.github.io/other/', [pdf('old2.pdf')], 0);
    await stashFiles(storage, SCOPE, [pdf('new.pdf')], STASH_MAX_AGE_MS);
    await purgeStaleStash(storage, STASH_MAX_AGE_MS + 1);
    // What is left is the fresh share: its file and its mark.
    expect(await entryPaths(storage)).toEqual(['0/0', 'complete']);
    await purgeStaleStash(memoryCacheStorage());
  });

  it('removes the stashes of the earlier layouts', async () => {
    const storage = memoryCacheStorage();
    await (await storage.open('pdfkey-incoming-v1')).put(`${SCOPE}x`, new Response('x'));
    await (await storage.open('pdfkey-incoming-v2')).put(`${SCOPE}y`, new Response('y'));
    await purgeStaleStash(storage);
    expect(await storage.keys()).toEqual([]);
  });
});

describe('share stash: large files', () => {
  /** 35 bytes, stashed in slices of 10. */
  const content = '%PDF-1.7 0123456789abcdefghijklmnop';
  const large = (name = 'large.pdf'): File =>
    new File([content], name, { type: 'application/pdf', lastModified: 1_650_000_000_123 });

  it('slices far below the limit browsers put on one entry', () => {
    // Chromium refuses a cache entry of 256 MiB (2^31 / 8 bytes) or more.
    expect(STASH_SLICE_BYTES).toBeLessThanOrEqual(2 ** 28 / 2);
    expect(STASH_SLICE_BYTES).toBeGreaterThanOrEqual(2 ** 20);
  });

  it('parks a file in slices and hands the page one file again', async () => {
    const storage = memoryCacheStorage();
    const report = await stashFiles(storage, SCOPE, [large()], 1000, 10);
    expect(report).toEqual({ stored: 1, failed: 0 });
    expect(await entryPaths(storage)).toEqual(['0/0', '0/1', '0/2', '0/3', 'complete']);

    const [[file]] = (await takeStashedFiles(storage, SCOPE, 1000)) as [[File]];
    expect(file.name).toBe('large.pdf');
    expect(file.type).toBe('application/pdf');
    expect(file.lastModified).toBe(1_650_000_000_123);
    expect(file.size).toBe(content.length);
    expect(await file.text()).toBe(content);
    expect(await entryCount(storage)).toBe(0);
  });

  it('keeps sliced and unsliced files of one share in order', async () => {
    const storage = memoryCacheStorage();
    const files = [pdf('a.pdf', 'a'), large('b.pdf'), new File([], 'empty.pdf'), large('d.pdf')];
    expect(await stashFiles(storage, SCOPE, files, 1000, 16)).toEqual({ stored: 4, failed: 0 });
    // Twelve files and more than ten slices: positions are numbers, not text.
    const many = Array.from(
      { length: 12 },
      (_, index) => new File(['x'.repeat(index)], `${index}`),
    );
    await stashFiles(storage, SCOPE, many, 2000, 1);

    const batches = await takeStashedFiles(storage, SCOPE, 2000);
    expect(batches.map((batch) => batch.map((file) => file.name))).toEqual([
      ['a.pdf', 'b.pdf', 'empty.pdf', 'd.pdf'],
      // The empty first file has one (empty) slice like every other.
      many.map((file) => file.name),
    ]);
    expect(await Promise.all(batches[0]!.map((file) => file.text()))).toEqual([
      '%PDF-1.7 a',
      content,
      '',
      content,
    ]);
    expect(batches[1]!.map((file) => file.size)).toEqual(many.map((file) => file.size));
  });

  it('gives a sliced file to only one of several tabs', async () => {
    const storage = memoryCacheStorage();
    await stashFiles(storage, SCOPE, [large('a.pdf'), large('b.pdf')], 1000, 10);
    const results = await Promise.all([
      takeStashedFiles(storage, SCOPE, 1000),
      takeStashedFiles(storage, SCOPE, 1000),
      takeStashedFiles(storage, SCOPE, 1000),
    ]);
    const files = results.flat(2);
    expect(files.map((file) => file.name).sort()).toEqual(['a.pdf', 'b.pdf']);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual([content, content]);
    expect(await entryCount(storage)).toBe(0);
  });

  it('leaves a share alone while the worker is still writing it', async () => {
    const storage = memoryCacheStorage();
    await stashFiles(storage, SCOPE, [pdf('ready.pdf'), large()], 1000, 10);
    // As it was a moment earlier: the last slice of the large file and the mark are to come.
    const cache = await storage.open(STASH_CACHE);
    const keys = await cache.keys();
    const pending = [
      keys.find((request) => request.url.endsWith('/1/3'))!,
      keys.find((request) => request.url.endsWith('/complete'))!,
    ];
    const responses = await Promise.all(
      pending.map(async (request) => (await cache.match(request))!),
    );
    await Promise.all(pending.map((request) => cache.delete(request)));

    // Not even the file that is finished is taken: a share is not split between two collectors.
    expect(await takeStashedFiles(storage, SCOPE, 1000)).toEqual([]);
    expect(await entryPaths(storage)).toEqual(['0/0', '0/1', '1/0', '1/1', '1/2']);

    // The rest arrives: now the share is whole.
    await cache.put(pending[0]!, responses[0]!);
    expect(await takeStashedFiles(storage, SCOPE, 1000)).toEqual([]);
    await cache.put(pending[1]!, responses[1]!);
    const [batch] = await takeStashedFiles(storage, SCOPE, 1000);
    expect(batch!.map((file) => file.name)).toEqual(['ready.pdf', 'large.pdf']);
    expect(await batch![1]!.text()).toBe(content);
    expect(await entryCount(storage)).toBe(0);
  });

  it('discards a file that never became whole once it is stale', async () => {
    const storage = memoryCacheStorage();
    await stashFiles(storage, SCOPE, [large()], 1000, 10);
    const cache = await storage.open(STASH_CACHE);
    await cache.delete((await cache.keys())[1]!);
    expect(await takeStashedFiles(storage, SCOPE, 1001 + STASH_MAX_AGE_MS)).toEqual([]);
    expect(await entryCount(storage)).toBe(0);
  });

  it('reports a file the storage refuses and leaves nothing of it behind', async () => {
    // The third slice of the second file does not fit any more.
    const storage = storageRefusing((url) => url.endsWith('/1/2'));
    const files = [large('fits.pdf'), large('too-much.pdf'), pdf('small.pdf')];
    expect(await stashFiles(storage, SCOPE, files, 1000, 10)).toEqual({ stored: 2, failed: 1 });
    expect(await entryPaths(storage)).toEqual([
      '0/0',
      '0/1',
      '0/2',
      '0/3',
      '2/0',
      '2/1',
      'complete',
    ]);

    const batches = await takeStashedFiles(storage, SCOPE, 1000);
    expect(batches.map((batch) => batch.map((file) => file.name))).toEqual([
      ['fits.pdf', 'small.pdf'],
    ]);
  });

  it('reports every file when the share cannot be marked complete', async () => {
    const storage = storageRefusing((url) => url.endsWith('/complete'));
    const report = await stashFiles(storage, SCOPE, [large(), pdf('small.pdf')], 1000, 10);
    expect(report).toEqual({ stored: 0, failed: 2 });
    expect(await entryCount(storage)).toBe(0);
  });

  it('reports every file when nothing can be stored', async () => {
    const storage = storageRefusing(() => true);
    const report = await stashFiles(storage, SCOPE, [large(), pdf('small.pdf')], 1000, 10);
    expect(report).toEqual({ stored: 0, failed: 2 });
    expect(await entryCount(storage)).toBe(0);
  });
});

describe('the address after a share', () => {
  const at = (path: string): URL => new URL(path, SCOPE);

  it('is the plain one when everything arrived', () => {
    expect(shareRedirect(0)).toBe(SHARE_REDIRECT);
    expect(lostInShare(at(SHARE_REDIRECT))).toBeNull();
  });

  it('says how many files were lost, or that all were', () => {
    expect(shareRedirect(2)).toBe('./?source=share-target&lost=2');
    expect(lostInShare(at(shareRedirect(2)))).toBe(2);
    expect(shareRedirect(SHARE_LOST_ALL)).toBe('./?source=share-target&lost=all');
    expect(lostInShare(at(shareRedirect(SHARE_LOST_ALL)))).toBe(SHARE_LOST_ALL);
  });

  it('reads anything odd as a loss, and nothing into other addresses', () => {
    expect(lostInShare(at('./?source=share-target&lost='))).toBe(SHARE_LOST_ALL);
    expect(lostInShare(at('./?source=share-target&lost=-1'))).toBe(SHARE_LOST_ALL);
    expect(lostInShare(at('./?source=share-target&lost=1.5'))).toBe(SHARE_LOST_ALL);
    expect(lostInShare(at('./?lost=3'))).toBeNull();
    expect(lostInShare(at('./?mode=lock'))).toBeNull();
  });
});

describe('filesFromForm', () => {
  it('collects files from any field and ignores text and empty file fields', () => {
    const form = new FormData();
    form.append('title', 'Shared from Files');
    form.append('pdfs', pdf('a.pdf'));
    form.append('pdfs', pdf('b.pdf'));
    form.append('other', pdf('c.pdf'));
    form.append('empty', new File([], ''));
    form.append('zero', new File([], 'zero-bytes.pdf'));
    expect(filesFromForm(form).map((file) => file.name)).toEqual([
      'a.pdf',
      'b.pdf',
      'c.pdf',
      'zero-bytes.pdf',
    ]);
  });
});

describe('isShareTargetUrl', () => {
  it('matches the share target inside the scope only', () => {
    expect(isShareTargetUrl(`${SCOPE}share-target`, SCOPE)).toBe(true);
    expect(isShareTargetUrl(`${SCOPE}share-target?x=1`, SCOPE)).toBe(true);
    expect(isShareTargetUrl(`${SCOPE}share-target/`, SCOPE)).toBe(false);
    expect(isShareTargetUrl(`${SCOPE}`, SCOPE)).toBe(false);
    expect(isShareTargetUrl('https://user.github.io/share-target', SCOPE)).toBe(false);
    expect(isShareTargetUrl('https://evil.example/PDF-/share-target', SCOPE)).toBe(false);
  });

  it('redirects to a relative URL inside the scope', () => {
    expect(new URL(SHARE_REDIRECT, SCOPE).href).toBe(`${SCOPE}?source=share-target`);
  });

  it('agrees with the share target declared in the web manifest', () => {
    // The manifest lives in vite.config.ts, which cannot import application modules.
    const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
    expect(config).toContain(`action: './${SHARE_TARGET_PATH}'`);
    expect(config).toContain(`files: [{ name: '${SHARE_FILES_FIELD}',`);
  });
});
