import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIncomingFiles,
  onIncomingFiles,
  onLaunchUrl,
  type IncomingEnvironment,
} from './incoming';
import { stashFiles } from './share-stash';
import { memoryCacheStorage, settle } from './testing';

const SCOPE = 'https://user.github.io/PDF-/';

function pdf(name: string): File {
  return new File([`%PDF-1.7 ${name}`], name, { type: 'application/pdf' });
}

function fileHandle(file: File | Error): FileSystemHandle {
  return {
    kind: 'file',
    name: file instanceof File ? file.name : 'broken.pdf',
    getFile: async () => {
      if (file instanceof Error) throw file;
      return file;
    },
  } as unknown as FileSystemHandle;
}

interface LaunchParamsLike {
  targetURL?: string;
  files?: FileSystemHandle[];
}

function setup(url = SCOPE) {
  let consumer: ((params: LaunchParamsLike) => void) | null = null;
  const queued: LaunchParamsLike[] = [];
  const state = { url, now: 0 };
  const env: IncomingEnvironment = {
    scope: SCOPE,
    initialUrl: url,
    now: () => state.now,
    caches: memoryCacheStorage(),
    launchQueue: {
      setConsumer(next) {
        consumer = next;
        // Like the browser: launches that happened before a consumer existed are replayed.
        for (const params of queued.splice(0)) next(params);
      },
    },
    currentUrl: () => state.url,
    replaceUrl: (next) => {
      state.url = next;
    },
  };
  const launch = (params: LaunchParamsLike): void => {
    if (consumer) consumer(params);
    else queued.push(params);
  };
  return { env, state, launch, incoming: createIncomingFiles(env) };
}

type Received = [string[], string];

function recorder() {
  const received: Received[] = [];
  const handler = (files: File[], source: string): void => {
    received.push([files.map((file) => file.name), source]);
  };
  return { received, handler };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('incoming files: share target', () => {
  it('delivers files that were stashed before the handler registered', async () => {
    const { env, incoming } = setup(`${SCOPE}?source=share-target`);
    await stashFiles(env.caches!, SCOPE, [pdf('a.pdf'), pdf('b.pdf')]);
    const { received, handler } = recorder();
    incoming.onIncomingFiles(handler);
    expect(received).toEqual([]);
    await settle();
    expect(received).toEqual([[['a.pdf', 'b.pdf'], 'share-target']]);
  });

  it('removes the share marker from the address but keeps everything else', async () => {
    const { state, incoming } = setup(`${SCOPE}?mode=unlock&source=share-target#top`);
    incoming.onIncomingFiles(() => undefined);
    await settle();
    expect(state.url).toBe(`${SCOPE}?mode=unlock#top`);
  });

  it('leaves other addresses alone', async () => {
    const { state, incoming } = setup(`${SCOPE}?source=elsewhere&mode=lock`);
    incoming.onIncomingFiles(() => undefined);
    await settle();
    expect(state.url).toBe(`${SCOPE}?source=elsewhere&mode=lock`);
  });

  it('delivers each batch exactly once, also across re-registration', async () => {
    const { env, incoming } = setup();
    await stashFiles(env.caches!, SCOPE, [pdf('a.pdf')]);
    const first = recorder();
    const off = incoming.onIncomingFiles(first.handler);
    await settle();
    off();
    const second = recorder();
    incoming.onIncomingFiles(second.handler);
    await settle();
    expect(first.received).toHaveLength(1);
    expect(second.received).toEqual([]);
  });

  it('buffers batches while no handler is registered', async () => {
    const { env, incoming, launch } = setup();
    const first = recorder();
    const off = incoming.onIncomingFiles(first.handler);
    await settle();
    off();

    await stashFiles(env.caches!, SCOPE, [pdf('late.pdf')]);
    launch({ targetURL: `${SCOPE}?source=share-target` });
    launch({ targetURL: SCOPE, files: [fileHandle(pdf('opened.pdf'))] });
    await settle();
    expect(first.received).toEqual([]);

    const second = recorder();
    incoming.onIncomingFiles(second.handler);
    await settle();
    expect(second.received).toEqual([
      [['opened.pdf'], 'file-handler'],
      [['late.pdf'], 'share-target'],
    ]);
  });

  it('the newest handler replaces the previous one', async () => {
    const { incoming, launch } = setup();
    const first = recorder();
    const second = recorder();
    const offFirst = incoming.onIncomingFiles(first.handler);
    incoming.onIncomingFiles(second.handler);
    // Unsubscribing a replaced handler must not remove its successor.
    offFirst();
    launch({ files: [fileHandle(pdf('x.pdf'))] });
    await settle();
    expect(first.received).toEqual([]);
    expect(second.received).toEqual([[['x.pdf'], 'file-handler']]);
  });

  it('works without Cache Storage and without a launch queue', async () => {
    const incoming = createIncomingFiles({
      scope: SCOPE,
      initialUrl: `${SCOPE}?source=share-target`,
      currentUrl: () => `${SCOPE}?source=share-target`,
      replaceUrl: () => undefined,
      now: () => 0,
    });
    const { received, handler } = recorder();
    incoming.onIncomingFiles(handler);
    await settle();
    expect(received).toEqual([]);
  });

  it('survives a broken Cache Storage', async () => {
    const { env, state, incoming } = setup(`${SCOPE}?source=share-target`);
    env.caches = {
      has: async () => {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as CacheStorage;
    const { received, handler } = recorder();
    incoming.onIncomingFiles(handler);
    await settle();
    expect(received).toEqual([]);
    expect(state.url).toBe(SCOPE);
  });
});

describe('incoming files: file handler', () => {
  it('delivers files the app was launched with before the handler registered', async () => {
    const { incoming, launch } = setup();
    launch({ targetURL: SCOPE, files: [fileHandle(pdf('a.pdf')), fileHandle(pdf('b.pdf'))] });
    const { received, handler } = recorder();
    incoming.onIncomingFiles(handler);
    await settle();
    expect(received).toEqual([[['a.pdf', 'b.pdf'], 'file-handler']]);
  });

  it('delivers every later launch as its own batch', async () => {
    const { incoming, launch } = setup();
    const { received, handler } = recorder();
    incoming.onIncomingFiles(handler);
    launch({ files: [fileHandle(pdf('1.pdf'))] });
    launch({ files: [fileHandle(pdf('2.pdf')), fileHandle(pdf('3.pdf'))] });
    await settle();
    expect(received).toEqual([
      [['1.pdf'], 'file-handler'],
      [['2.pdf', '3.pdf'], 'file-handler'],
    ]);
  });

  it('skips unreadable files and directories, and ignores launches without files', async () => {
    const { incoming, launch } = setup();
    const { received, handler } = recorder();
    incoming.onIncomingFiles(handler);
    launch({
      files: [
        fileHandle(new Error('gone')),
        { kind: 'directory', name: 'folder' } as unknown as FileSystemHandle,
        fileHandle(pdf('ok.pdf')),
      ],
    });
    launch({ targetURL: SCOPE });
    launch({ files: [fileHandle(new Error('gone'))] });
    await settle();
    expect(received).toEqual([[['ok.pdf'], 'file-handler']]);
  });

  it('keeps delivering after a handler throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { incoming, launch } = setup();
    const names: string[] = [];
    incoming.onIncomingFiles((files) => {
      names.push(files[0]!.name);
      if (names.length === 1) throw new Error('consumer bug');
    });
    launch({ files: [fileHandle(pdf('1.pdf'))] });
    launch({ files: [fileHandle(pdf('2.pdf'))] });
    await settle();
    expect(names).toEqual(['1.pdf', '2.pdf']);
    expect(errors).toHaveBeenCalledOnce();
  });
});

describe('launch URLs', () => {
  it('does not report the launch that loaded the page', async () => {
    const { incoming, launch } = setup(`${SCOPE}?mode=unlock`);
    // Queued by the browser before any consumer existed.
    launch({ targetURL: `${SCOPE}?mode=unlock` });
    const urls: string[] = [];
    incoming.onLaunchUrl((url) => urls.push(url.href));
    await settle();
    expect(urls).toEqual([]);
  });

  it('reports every later launch, even one with the address the page was loaded with', async () => {
    const { incoming, launch, state } = setup(`${SCOPE}?mode=unlock`);
    const urls: string[] = [];
    incoming.onLaunchUrl((url) => urls.push(url.href));
    launch({ targetURL: `${SCOPE}?mode=unlock` });
    await settle();

    state.now = 60_000;
    launch({ targetURL: `${SCOPE}?mode=lock` });
    await settle();
    // The user switched modes inside the app meanwhile and now taps the "Unlock" shortcut.
    launch({ targetURL: `${SCOPE}?mode=unlock` });
    await settle();
    expect(urls).toEqual([`${SCOPE}?mode=lock`, `${SCOPE}?mode=unlock`]);
  });

  it('reports a different launch that was queued while the page was still loading', async () => {
    const { incoming, launch } = setup(SCOPE);
    launch({ targetURL: SCOPE });
    launch({ targetURL: `${SCOPE}?mode=lock` });
    const urls: string[] = [];
    incoming.onLaunchUrl((url) => urls.push(url.href));
    await settle();
    expect(urls).toEqual([`${SCOPE}?mode=lock`]);
  });

  it('does not report share-target or file launches as URLs', async () => {
    const { incoming, launch, state } = setup(`${SCOPE}?mode=lock`);
    const urls: string[] = [];
    incoming.onLaunchUrl((url) => urls.push(url.href));
    incoming.onIncomingFiles(() => undefined);
    state.now = 60_000;
    launch({ targetURL: `${SCOPE}share-target` });
    launch({ targetURL: `${SCOPE}?source=share-target` });
    launch({ targetURL: SCOPE, files: [fileHandle(pdf('a.pdf'))] });
    await settle();
    expect(urls).toEqual([]);
  });

  it('keeps the latest URL until a handler registers', async () => {
    const { incoming, launch, state } = setup();
    incoming.onIncomingFiles(() => undefined);
    state.now = 60_000;
    launch({ targetURL: `${SCOPE}?mode=unlock` });
    launch({ targetURL: `${SCOPE}?mode=lock` });
    await settle();
    const urls: string[] = [];
    incoming.onLaunchUrl((url) => urls.push(url.searchParams.get('mode')!));
    await settle();
    expect(urls).toEqual(['lock']);
  });

  it('resolves relative launch URLs against the app scope', async () => {
    const { incoming, launch, state } = setup();
    const urls: string[] = [];
    incoming.onLaunchUrl((url) => urls.push(url.href));
    state.now = 60_000;
    launch({ targetURL: './?mode=lock' });
    await settle();
    expect(urls).toEqual([`${SCOPE}?mode=lock`]);
  });
});

describe('outside a browser', () => {
  it('registers nothing and returns a working unsubscribe function', () => {
    expect(() => onIncomingFiles(() => undefined)()).not.toThrow();
    expect(() => onLaunchUrl(() => undefined)()).not.toThrow();
  });
});
