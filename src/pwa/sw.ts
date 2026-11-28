/**
 * Service worker: offline support, the receiving end of the Web Share Target, and the files of
 * the previous build for windows that still run it.
 *
 * Built by vite-plugin-pwa (injectManifest); `self.__WB_MANIFEST` is replaced with the list of
 * every file of the build, including the engine's worker bundle and WebAssembly module.
 */
import { cacheNames, clientsClaim } from 'workbox-core';
import { PrecacheController, PrecacheRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { keepPreviousBuild, matchPreviousBuild, prunePreviousBuilds } from './previous-builds';
import {
  PAGE_LOADED,
  SHARE_PING,
  SHARE_RECEIVED,
  SKIP_WAITING,
  type PageLoadedMessage,
  type SharePingMessage,
  type ShareReceivedMessage,
  type SkipWaitingMessage,
} from './protocol';
import {
  SHARE_LOST_ALL,
  filesFromForm,
  isShareTargetUrl,
  purgeStaleStash,
  shareRedirect,
  stashFiles,
} from './share-stash';

// The project is type-checked with the DOM library, which does not know the service worker
// global scope. These are the few members used here; declaring them locally avoids pulling the
// conflicting "webworker" library into every other file of the project.
interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  readonly clientId: string;
  readonly resultingClientId?: string;
  respondWith(response: Response | Promise<Response>): void;
}
interface ClientLike {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
interface MessageEventLike extends ExtendableEventLike {
  readonly data: unknown;
  readonly source: unknown;
}
interface ServiceWorkerScope {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
  readonly registration: ServiceWorkerRegistration;
  readonly clients: {
    matchAll(options: {
      type: 'window';
      includeUncontrolled: boolean;
    }): Promise<readonly ClientLike[]>;
    get(id: string): Promise<ClientLike | undefined>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
}
declare const self: ServiceWorkerScope;

const scope = self.registration.scope;

/**
 * The pages whose navigation this worker has answered: they run its build (see `tidyUp`).
 * Registered before every listener that answers requests: an answer ends the event for the
 * listeners after it.
 */
const pagesOfThisBuild = new Set<string>();
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate' && event.resultingClientId) {
    pagesOfThisBuild.add(event.resultingClientId);
  }
});

// --- Web Share Target ---------------------------------------------------------------------------
// Registered before the Workbox routes so that it sees the request first.

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isShareTargetUrl(request.url, scope)) return;
  event.respondWith(
    request.method === 'POST' ? receiveShare(request, event.clientId) : redirectToApp('./'),
  );
});

/** How long a page has to answer `SHARE_PING`. It answers at once; the rest is for a busy one. */
const SHARE_PING_TIMEOUT_MS = 2000;

/**
 * Parks the shared files for the page and opens the app. The app is opened whatever happens,
 * rather than a browser error page, and the address tells it how many files did not make it, so
 * that it can say so.
 *
 * Android sends the share of a running app into the window that is open. Loading the app anew
 * there would throw away its list, its results and what was typed, so that window keeps its
 * page: it is told to collect the files, and the navigation is answered with "no content",
 * which makes the browser drop it.
 */
async function receiveShare(request: Request, clientId: string): Promise<Response> {
  // Asked first: the answer is there by the time the files are parked.
  const running = runningApp(clientId);
  let lost: number | typeof SHARE_LOST_ALL = SHARE_LOST_ALL;
  try {
    const files = filesFromForm(await request.formData());
    // A share without a single file has nothing for the app either.
    if (files.length > 0) lost = (await stashFiles(caches, scope, files)).failed;
  } catch {
    // Malformed form, or no storage at all.
  }
  const address = shareRedirect(lost);
  const open = await running;
  if (!open) return redirectToApp(address);
  const message: ShareReceivedMessage = { type: SHARE_RECEIVED, url: new URL(address, scope).href };
  open.postMessage(message);
  return new Response(null, { status: 204 });
}

/**
 * The window this navigation is about to replace, if it runs the app and says so. Chromium
 * names the document a navigation replaces as the client of its request; where a browser does
 * not, or the window is new, shows something else or does not answer, there is none.
 */
async function runningApp(clientId: string): Promise<ClientLike | null> {
  try {
    const client = clientId ? await self.clients.get(clientId) : undefined;
    if (!client || client.type !== 'window' || !client.url.startsWith(scope)) return null;
    const answered = await new Promise<boolean>((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => resolve(true);
      setTimeout(() => resolve(false), SHARE_PING_TIMEOUT_MS);
      const ping: SharePingMessage = { type: SHARE_PING };
      client.postMessage(ping, [port2]);
    });
    return answered ? client : null;
  } catch {
    return null;
  }
}

/** 303: the browser follows with a GET, so reloading the app never re-submits the share. */
function redirectToApp(path: string): Response {
  return Response.redirect(new URL(path, scope).href, 303);
}

// --- Offline support ----------------------------------------------------------------------------

cleanupOutdatedCaches();
// What `precacheAndRoute` does, with the installation in this file's hands: it has an order (see
// below).
const precache = new PrecacheController();
precache.addToCacheList(self.__WB_MANIFEST);
registerRoute(new PrecacheRoute(precache));
// Navigations to the app's own folder (the start URL with ?mode=… or ?source=…, or any name in
// it) are answered with the cached app shell. Deeper paths are left to the network: the shell
// refers to its files with relative URLs, which would not resolve from there.
const scopePath = new URL(scope).pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
registerRoute(
  new NavigationRoute(precache.createHandlerBoundToURL('index.html'), {
    allowlist: [new RegExp(`^${scopePath}[^/?]*(?:\\?.*)?$`)],
  }),
);

// --- Windows that still run the previous build ----------------------------------------------------
// See previous-builds.ts. The files are set aside while this version installs (the precache is
// then still that of the running one), and served by the last route: it sees what neither the
// precache nor the app shell answers.

const inThisBuild = (url: string): boolean => precache.getCacheKeyForURL(url) !== undefined;

self.addEventListener('install', (event) => {
  // First the files of this version, then the copies of the one before: where storage is
  // short, the update gets the room, and it does not fail for want of the copies.
  event.waitUntil(
    precache
      .install(event)
      .then(() =>
        keepPreviousBuild(caches, scope, cacheNames.precache, inThisBuild).catch(() => undefined),
      ),
  );
});

registerRoute(
  ({ url, request, sameOrigin }) =>
    sameOrigin && request.mode !== 'navigate' && url.href.startsWith(scope),
  async ({ request }) => (await matchPreviousBuild(caches, scope, request)) ?? fetch(request),
);

// A first installation takes control of the page that registered it, so that page is offline
// capable without a reload. Updates are different: a new version waits until the user agrees.
clientsClaim();

self.addEventListener('message', (event) => {
  const data = event.data as Partial<SkipWaitingMessage | PageLoadedMessage> | null;
  if (data?.type === SKIP_WAITING) void self.skipWaiting();
  else if (data?.type === PAGE_LOADED) event.waitUntil(tidyUp(event.source).catch(() => undefined));
});

/**
 * A page has loaded. If it is one of this version and no other window of the app is open, no
 * code of an earlier build is running any more, and what was kept for it can go; so cleaning
 * up does not have to wait for the next release. A page this worker does not know (it took the
 * page over from the version before, or was restarted meanwhile) counts as a window that may
 * run an earlier build, like any other.
 */
async function tidyUp(page: unknown): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const sender = (page as Partial<ClientLike> | null)?.id;
  const mine = sender !== undefined && pagesOfThisBuild.delete(sender);
  const others = windows.filter(
    (client) => client.url.startsWith(scope) && !(mine && client.id === sender),
  );
  await prunePreviousBuilds(caches, scope, others.length, Date.now(), inThisBuild);
}

self.addEventListener('activate', (event) => {
  event.waitUntil(precache.activate(event));
  event.waitUntil(purgeStaleStash(caches).catch(() => undefined));
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => prunePreviousBuilds(caches, scope, windows.length))
      .catch(() => undefined),
  );
});
