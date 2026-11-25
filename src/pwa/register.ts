/** Service worker registration and update flow. CONTRACT STUB — implemented by the platform workstream. */

export interface ServiceWorkerHooks {
  /** A new version is waiting. Call `apply()` to activate it and reload the page. */
  onNeedRefresh?: (apply: () => Promise<void>) => void;
  /** Everything is cached; the app now works offline. Fired once per installation. */
  onOfflineReady?: () => void;
}

/** No-op in development and wherever service workers are unavailable. */
export function registerServiceWorker(_hooks?: ServiceWorkerHooks): void {
  throw new Error('not implemented');
}
