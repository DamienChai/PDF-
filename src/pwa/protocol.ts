/** Messages exchanged between the page and the service worker. */

/** Page → waiting worker: the user accepted the update, activate now. */
export const SKIP_WAITING = 'SKIP_WAITING';

export interface SkipWaitingMessage {
  type: typeof SKIP_WAITING;
}

/**
 * Page → the worker that controls it, once the page has loaded: the page runs that worker's
 * build, which is the moment to drop files of earlier builds that nothing can ask for any more
 * (see previous-builds.ts).
 */
export const PAGE_LOADED = 'PAGE_LOADED';

export interface PageLoadedMessage {
  type: typeof PAGE_LOADED;
}

/**
 * Worker → page, with a message port: "are you the app, and listening?" The page answers on the
 * port. Asked before the worker leaves a share to the page that is open instead of loading a
 * new one; a page that does not answer (another document, an older build) is replaced as before.
 */
export const SHARE_PING = 'SHARE_PING';

export interface SharePingMessage {
  type: typeof SHARE_PING;
}

/**
 * Worker → the page that answered the ping: the files of a share are parked, collect them.
 * `url` is the address a new page would have been sent to; it says what was lost on the way.
 */
export const SHARE_RECEIVED = 'SHARE_RECEIVED';

export interface ShareReceivedMessage {
  type: typeof SHARE_RECEIVED;
  url: string;
}
