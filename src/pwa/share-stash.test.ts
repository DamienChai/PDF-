import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SHARE_FILES_FIELD,
  SHARE_REDIRECT,
  SHARE_TARGET_PATH,
  STASH_CACHE,
  STASH_MAX_AGE_MS,
  filesFromForm,
  isShareTargetUrl,
  purgeStaleStash,
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

  it('gives each file to only one of several tabs collecting at the same time', async () => {
    const storage = memoryCacheStorage();
    await stashFiles(storage, SCOPE, [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    const results = await Promise.all([
      takeStashedFiles(storage, SCOPE),
      takeStashedFiles(storage, SCOPE),
      takeStashedFiles(storage, SCOPE),
    ]);
    const names = results.flat(2).map((file) => file.name);
    expect(names.sort()).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
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
      `${SCOPE}__pdfkey-incoming__/000000000001000-ab/0`,
      new Response('x', { headers: { 'X-PDFKey-Received': '1000' } }),
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
    expect(await entryCount(storage)).toBe(1);
    await purgeStaleStash(memoryCacheStorage());
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
