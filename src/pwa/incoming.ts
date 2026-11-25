/**
 * Files handed to the app from outside: Android share sheet (Web Share Target) and
 * "Open with" on desktop (File Handling API / launch queue).
 */
import {
  SHARE_SOURCE_PARAM,
  SHARE_SOURCE_VALUE,
  isShareTargetUrl,
  takeStashedFiles,
} from './share-stash';

export type IncomingSource = 'share-target' | 'file-handler';

type FilesHandler = (files: File[], source: IncomingSource) => void;
type UrlHandler = (url: URL) => void;

// --- Launch Handler / File Handling API (not part of the TypeScript DOM library) ---------------

interface LaunchParams {
  readonly targetURL?: string;
  readonly files?: readonly FileSystemHandle[];
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

/** Everything this module needs from the browser; replaced by fakes in tests. */
export interface IncomingEnvironment {
  /** Base URL of the app (the service worker scope). */
  scope: string;
  caches?: CacheStorage | undefined;
  launchQueue?: LaunchQueue | undefined;
  /** Address the page was loaded with. */
  initialUrl: string;
  /** Current address of the page. */
  currentUrl(): string;
  /** Replaces the address shown for the page without navigating. */
  replaceUrl(url: string): void;
  now(): number;
}

/**
 * The launch that loaded the page is reported through the launch queue like any other, as soon
 * as a consumer is set. A launch that arrives this soon after and points at the address the page
 * was loaded with is that one, not a new request by the user.
 */
const INITIAL_LAUNCH_WINDOW_MS = 1000;

interface Batch {
  files: File[];
  source: IncomingSource;
}

function isFileHandle(handle: FileSystemHandle): handle is FileSystemFileHandle {
  return handle.kind === 'file';
}

/** Compares two addresses, ignoring the fragment. */
function sameDocument(a: URL, b: URL): boolean {
  return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
}

export interface IncomingFiles {
  onIncomingFiles(handler: FilesHandler): () => void;
  onLaunchUrl(handler: UrlHandler): () => void;
}

export function createIncomingFiles(env: IncomingEnvironment): IncomingFiles {
  let filesHandler: FilesHandler | null = null;
  let urlHandler: UrlHandler | null = null;
  const pendingBatches: Batch[] = [];
  let pendingUrl: URL | null = null;
  let started = false;
  let consumerSetAt = 0;
  let collection: Promise<void> = Promise.resolve();

  function flush(): void {
    while (filesHandler && pendingBatches.length > 0) {
      const batch = pendingBatches.shift()!;
      try {
        filesHandler(batch.files, batch.source);
      } catch (error) {
        // A failing consumer must not block later batches.
        console.error(error);
      }
    }
    if (urlHandler && pendingUrl) {
      const url = pendingUrl;
      pendingUrl = null;
      try {
        urlHandler(url);
      } catch (error) {
        console.error(error);
      }
    }
  }

  function deliver(files: File[], source: IncomingSource): void {
    if (files.length === 0) return;
    pendingBatches.push({ files, source });
    flush();
  }

  /** Drops the "?source=share-target" marker so that a reload or a bookmark stays clean. */
  function removeShareMarker(): void {
    try {
      const url = new URL(env.currentUrl());
      if (url.searchParams.get(SHARE_SOURCE_PARAM) !== SHARE_SOURCE_VALUE) return;
      url.searchParams.delete(SHARE_SOURCE_PARAM);
      env.replaceUrl(url.href);
    } catch {
      // Purely cosmetic.
    }
  }

  async function collectNow(): Promise<void> {
    try {
      if (!env.caches) return;
      for (const files of await takeStashedFiles(env.caches, env.scope)) {
        deliver(files, 'share-target');
      }
    } catch {
      // Cache Storage unavailable (private mode, storage pressure): nothing to collect.
    } finally {
      removeShareMarker();
    }
  }

  /** Collections run one after the other, so a later call also sees what arrived meanwhile. */
  function collectShared(): Promise<void> {
    collection = collection.then(collectNow);
    return collection;
  }

  async function onLaunch(params: LaunchParams): Promise<void> {
    const handles = (params.files ?? []).filter(isFileHandle);
    if (handles.length > 0) {
      const files = await Promise.all(
        // A file that was deleted or is unreadable is skipped; the others still arrive.
        handles.map((handle) => handle.getFile().catch(() => null)),
      );
      deliver(
        files.filter((file): file is File => file !== null),
        'file-handler',
      );
      return;
    }
    const arrivedAt = env.now();
    // A share that re-used this window instead of loading a fresh page.
    await collectShared();
    if (!params.targetURL) return;
    try {
      const target = new URL(params.targetURL, env.scope);
      // Shares are about their files, which travel through the stash.
      if (isShareTargetUrl(target.href, env.scope)) return;
      if (target.searchParams.get(SHARE_SOURCE_PARAM) === SHARE_SOURCE_VALUE) return;
      const isInitialLaunch =
        arrivedAt - consumerSetAt < INITIAL_LAUNCH_WINDOW_MS &&
        sameDocument(target, new URL(env.initialUrl));
      if (isInitialLaunch) return;
      pendingUrl = target;
      flush();
    } catch {
      // Unparsable URL: ignore.
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    void collectShared();
    // The browser keeps launches queued until a consumer is set, so nothing is lost by
    // attaching late; with `client_mode: focus-existing` it is called again for every re-launch.
    consumerSetAt = env.now();
    env.launchQueue?.setConsumer((params) => void onLaunch(params));
  }

  return {
    onIncomingFiles(handler) {
      filesHandler = handler;
      start();
      // Deliver what is already waiting once the caller has finished registering.
      queueMicrotask(flush);
      return () => {
        if (filesHandler === handler) filesHandler = null;
      };
    },
    onLaunchUrl(handler) {
      urlHandler = handler;
      start();
      queueMicrotask(flush);
      return () => {
        if (urlHandler === handler) urlHandler = null;
      };
    },
  };
}

let shared: IncomingFiles | null = null;

function browserInstance(): IncomingFiles | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  shared ??= createIncomingFiles({
    scope: new URL('./', document.baseURI).href,
    caches: 'caches' in window ? window.caches : undefined,
    launchQueue: (window as { launchQueue?: LaunchQueue }).launchQueue,
    // The navigation entry keeps the original address even after history.replaceState().
    initialUrl: performance.getEntriesByType('navigation')[0]?.name || window.location.href,
    currentUrl: () => window.location.href,
    replaceUrl: (url) => window.history.replaceState(window.history.state, '', url),
    now: () => performance.now(),
  });
  return shared;
}

/**
 * Registers the single consumer for incoming files. Files that arrived before registration are
 * delivered once, right after registering. Returns an unsubscribe function.
 */
export function onIncomingFiles(
  handler: (files: File[], source: IncomingSource) => void,
): () => void {
  return browserInstance()?.onIncomingFiles(handler) ?? (() => undefined);
}

/**
 * Registers the single consumer for launches that re-use this window without loading a new page.
 *
 * The manifest asks for `launch_handler.client_mode: "focus-existing"`: when the app is already
 * open and the user taps an app shortcut ("Lock", "Unlock"), the existing window is focused and
 * the shortcut's URL (e.g. `./?mode=lock`) arrives here instead of being navigated to. Launches
 * that carry files are reported through `onIncomingFiles` only, and the launch that loaded the
 * page is not reported at all (its URL is `location.href`).
 */
export function onLaunchUrl(handler: (url: URL) => void): () => void {
  return browserInstance()?.onLaunchUrl(handler) ?? (() => undefined);
}
