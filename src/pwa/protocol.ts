/** Messages exchanged between the page and the service worker. */

/** Page → waiting worker: the user accepted the update, activate now. */
export const SKIP_WAITING = 'SKIP_WAITING';

export interface SkipWaitingMessage {
  type: typeof SKIP_WAITING;
}
