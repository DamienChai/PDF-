/**
 * Service worker: offline support and the receiving end of the Web Share Target.
 *
 * Built by vite-plugin-pwa (injectManifest); `self.__WB_MANIFEST` is replaced with the list of
 * every file of the build, including the engine's worker bundle and WebAssembly module.
 */
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { SKIP_WAITING, type SkipWaitingMessage } from './protocol';
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
  respondWith(response: Response | Promise<Response>): void;
}
interface ServiceWorkerScope {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
  readonly registration: ServiceWorkerRegistration;
  skipWaiting(): Promise<void>;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
  addEventListener(type: 'activate', listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
declare const self: ServiceWorkerScope;

const scope = self.registration.scope;

// --- Web Share Target ---------------------------------------------------------------------------
// Registered before the Workbox routes so that it sees the request first.

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isShareTargetUrl(request.url, scope)) return;
  event.respondWith(request.method === 'POST' ? receiveShare(request) : redirectToApp('./'));
});

/**
 * Parks the shared files for the page and opens the app. The app is opened whatever happens,
 * rather than a browser error page, and the address tells it how many files did not make it, so
 * that it can say so.
 */
async function receiveShare(request: Request): Promise<Response> {
  let lost: number | typeof SHARE_LOST_ALL = SHARE_LOST_ALL;
  try {
    const files = filesFromForm(await request.formData());
    // A share without a single file has nothing for the app either.
    if (files.length > 0) lost = (await stashFiles(caches, scope, files)).failed;
  } catch {
    // Malformed form, or no storage at all.
  }
  return redirectToApp(shareRedirect(lost));
}

/** 303: the browser follows with a GET, so reloading the app never re-submits the share. */
function redirectToApp(path: string): Response {
  return Response.redirect(new URL(path, scope).href, 303);
}

// --- Offline support ----------------------------------------------------------------------------

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
// Navigations to the app's own folder (the start URL with ?mode=… or ?source=…, or any name in
// it) are answered with the cached app shell. Deeper paths are left to the network: the shell
// refers to its files with relative URLs, which would not resolve from there.
const scopePath = new URL(scope).pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    allowlist: [new RegExp(`^${scopePath}[^/?]*(?:\\?.*)?$`)],
  }),
);

// A first installation takes control of the page that registered it, so that page is offline
// capable without a reload. Updates are different: a new version waits until the user agrees.
clientsClaim();

self.addEventListener('message', (event) => {
  const data = event.data as Partial<SkipWaitingMessage> | null;
  if (data?.type === SKIP_WAITING) void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(purgeStaleStash(caches).catch(() => undefined));
});
