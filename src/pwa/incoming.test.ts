import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIncomingFiles,
  onIncomingFiles,
  onLaunchUrl,
  onShareProblem,
  type IncomingEnvironment,
  type ShareProblem,
} from './incoming';
import { SHARE_PING, SHARE_RECEIVED } from './protocol';
import { shareRedirect, stashFiles } from './share-stash';
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
    onWorkerMessage: (listener) => {
      toPage = listener;
    },
  };
  let toPage: ((data: unknown, reply: (answer: unknown) => void) => void) | null = null;
  const launch = (params: LaunchParamsLike): void => {
    if (consumer) consumer(params);
    else queued.push(params);
  };
  /** A message of the service worker to the page; returns what the page answered. */
  const fromWorker = (data: unknown): unknown[] => {
    const answers: unknown[] = [];
    toPage?.(data, (answer) => answers.push(answer));
    return answers;
  };
  return { env, state, launch, fromWorker, incoming: createIncomingFiles(env) };
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

const brokenStorage = {
  has: async () => {
    throw new DOMException('denied', 'SecurityError');
  },
} as unknown as CacheStorage;

describe('incoming files: a share that did not arrive', () => {
  it('reports that nothing arrived when the worker could not keep the files', async () => {
    const { state, incoming } = setup(`${SCOPE}?source=share-target&lost=all`);
    const problems: ShareProblem[] = [];
    const files = recorder();
    incoming.onIncomingFiles(files.handler);
    incoming.onShareProblem((problem) => problems.push(problem));
    await settle();
    expect(problems).toEqual([{ received: 0, lost: null }]);
    expect(files.received).toEqual([]);
    // A reload is an ordinary start: no marker, no second report.
    expect(state.url).toBe(SCOPE);
  });

  it('counts what was lost next to what arrived', async () => {
    const { env, state, incoming } = setup(`${SCOPE}?mode=lock&source=share-target&lost=1`);
    await stashFiles(env.caches!, SCOPE, [pdf('a.pdf'), pdf('b.pdf')]);
    const problems: ShareProblem[] = [];
    const files = recorder();
    incoming.onIncomingFiles(files.handler);
    incoming.onShareProblem((problem) => problems.push(problem));
    await settle();
    expect(files.received).toEqual([[['a.pdf', 'b.pdf'], 'share-target']]);
    expect(problems).toEqual([{ received: 2, lost: 1 }]);
    expect(state.url).toBe(`${SCOPE}?mode=lock`);
  });

  it('reports a share whose files the page cannot get at', async () => {
    for (const caches of [brokenStorage, undefined]) {
      const { env, incoming } = setup(`${SCOPE}?source=share-target`);
      env.caches = caches;
      const problems: ShareProblem[] = [];
      incoming.onShareProblem((problem) => problems.push(problem));
      await settle();
      expect(problems).toEqual([{ received: 0, lost: null }]);
    }
  });

  it('has nothing to report when storage is unusable and nothing was shared', async () => {
    for (const caches of [brokenStorage, undefined]) {
      const { env, incoming, launch } = setup(`${SCOPE}?mode=lock`);
      env.caches = caches;
      const problems: ShareProblem[] = [];
      incoming.onShareProblem((problem) => problems.push(problem));
      launch({ targetURL: `${SCOPE}?mode=unlock` });
      await settle();
      expect(problems).toEqual([]);
    }
  });

  it('is quiet about a share that arrived, even if another window took the files', async () => {
    const { incoming } = setup(`${SCOPE}?source=share-target`);
    const problems: ShareProblem[] = [];
    incoming.onShareProblem((problem) => problems.push(problem));
    await settle();
    expect(problems).toEqual([]);
  });

  it('reports once when the launch that loaded the page is replayed', async () => {
    const url = `${SCOPE}?source=share-target&lost=2`;
    const { incoming, launch } = setup(url);
    launch({ targetURL: url });
    const problems: ShareProblem[] = [];
    incoming.onShareProblem((problem) => problems.push(problem));
    await settle();
    expect(problems).toEqual([{ received: 0, lost: 2 }]);
  });

  it('reports a share into the running window', async () => {
    const { state, incoming, launch } = setup();
    const problems: ShareProblem[] = [];
    incoming.onShareProblem((problem) => problems.push(problem));
    await settle();
    state.now = 60_000;
    launch({ targetURL: `${SCOPE}?source=share-target&lost=all` });
    await settle();
    expect(problems).toEqual([{ received: 0, lost: null }]);
  });

  it('reports a share that only focused the running window: its files went nowhere', async () => {
    // Desktop Chromium with `client_mode: focus-existing`: no request is made for the share,
    // the window is told the address of the share target and gets no files.
    const { state, incoming, launch } = setup();
    const problems: ShareProblem[] = [];
    const files = recorder();
    const urls: string[] = [];
    incoming.onIncomingFiles(files.handler);
    incoming.onShareProblem((problem) => problems.push(problem));
    incoming.onLaunchUrl((url) => urls.push(url.href));
    launch({ targetURL: SCOPE });
    await settle();
    expect(problems).toEqual([]);

    state.now = 60_000;
    launch({ targetURL: `${SCOPE}share-target`, files: [] });
    await settle();
    expect(problems).toEqual([{ received: 0, lost: null }]);
    expect(files.received).toEqual([]);
    expect(urls).toEqual([]);
  });

  it('is quiet when the share that loaded the page is reported under the share target', async () => {
    const { env, incoming, launch } = setup(`${SCOPE}?source=share-target`);
    await stashFiles(env.caches!, SCOPE, [pdf('a.pdf')]);
    // Queued by the browser before any consumer existed.
    launch({ targetURL: `${SCOPE}share-target` });
    const problems: ShareProblem[] = [];
    const files = recorder();
    incoming.onIncomingFiles(files.handler);
    incoming.onShareProblem((problem) => problems.push(problem));
    await settle();
    expect(files.received).toEqual([[['a.pdf'], 'share-target']]);
    expect(problems).toEqual([]);
  });

  it('keeps the report until somebody listens, and gives it once', async () => {
    const { incoming } = setup(`${SCOPE}?source=share-target&lost=all`);
    incoming.onIncomingFiles(() => undefined);
    await settle();
    const first: ShareProblem[] = [];
    const off = incoming.onShareProblem((problem) => first.push(problem));
    await settle();
    off();
    const second: ShareProblem[] = [];
    incoming.onShareProblem((problem) => second.push(problem));
    await settle();
    expect(first).toEqual([{ received: 0, lost: null }]);
    expect(second).toEqual([]);
  });

  it('is a no-op outside a browser', () => {
    expect(() => onShareProblem(() => undefined)()).not.toThrow();
  });
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

describe('incoming files: a share the worker leaves to the page that is open', () => {
  it('answers the worker, then collects when told, and stays where it is', async () => {
    const { env, state, incoming, fromWorker } = setup(`${SCOPE}?mode=lock`);
    const files = recorder();
    const problems: ShareProblem[] = [];
    incoming.onIncomingFiles(files.handler);
    incoming.onShareProblem((problem) => problems.push(problem));
    await settle();

    // The worker asks before it decides; only an answer keeps the page.
    expect(fromWorker({ type: SHARE_PING })).toEqual([true]);
    expect(files.received).toEqual([]);

    await stashFiles(env.caches!, SCOPE, [pdf('a.pdf'), pdf('b.pdf')]);
    const url = new URL(shareRedirect(0), SCOPE).href;
    expect(fromWorker({ type: SHARE_RECEIVED, url })).toEqual([]);
    await settle();
    expect(files.received).toEqual([[['a.pdf', 'b.pdf'], 'share-target']]);
    expect(problems).toEqual([]);
    expect(state.url).toBe(`${SCOPE}?mode=lock`);
  });

  it('says what did not make it', async () => {
    const { env, incoming, fromWorker } = setup();
    const files = recorder();
    const problems: ShareProblem[] = [];
    incoming.onIncomingFiles(files.handler);
    incoming.onShareProblem((problem) => problems.push(problem));
    await settle();
    fromWorker({ type: SHARE_RECEIVED, url: new URL(shareRedirect('all'), SCOPE).href });
    await settle();
    await stashFiles(env.caches!, SCOPE, [pdf('a.pdf')]);
    fromWorker({ type: SHARE_RECEIVED, url: new URL(shareRedirect(2), SCOPE).href });
    await settle();
    expect(files.received).toEqual([[['a.pdf'], 'share-target']]);
    expect(problems).toEqual([
      { received: 0, lost: null },
      { received: 1, lost: 2 },
    ]);
  });

  it('does not take a launch for a lost share while the worker is bringing the files', async () => {
    const { env, state, incoming, launch, fromWorker } = setup();
    const files = recorder();
    const problems: ShareProblem[] = [];
    incoming.onIncomingFiles(files.handler);
    incoming.onShareProblem((problem) => problems.push(problem));
    await settle();
    state.now = 60_000;
    fromWorker({ type: SHARE_PING });
    launch({ targetURL: `${SCOPE}share-target` });
    await settle();
    expect(problems).toEqual([]);
    await stashFiles(env.caches!, SCOPE, [pdf('a.pdf')]);
    fromWorker({ type: SHARE_RECEIVED, url: new URL(shareRedirect(0), SCOPE).href });
    await settle();
    expect(files.received).toEqual([[['a.pdf'], 'share-target']]);
    expect(problems).toEqual([]);
  });

  it('ignores other messages', async () => {
    const { incoming, fromWorker } = setup();
    const problems: ShareProblem[] = [];
    incoming.onShareProblem((problem) => problems.push(problem));
    await settle();
    expect(fromWorker(null)).toEqual([]);
    expect(fromWorker({ type: 'SOMETHING_ELSE' })).toEqual([]);
    expect(fromWorker({ type: SHARE_RECEIVED })).toEqual([]);
    await settle();
    expect(problems).toEqual([]);
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
