/** "Install app" prompt handling. CONTRACT STUB — implemented by the platform workstream. */
import type { ReadonlySignal } from '@preact/signals';

/**
 * - `unavailable`  the browser offers no programmatic install prompt (yet)
 * - `available`    `promptInstall()` will show the native install dialog
 * - `installed`    running as an installed app (standalone display mode) or just installed
 */
export type InstallState = 'unavailable' | 'available' | 'installed';

export declare const installState: ReadonlySignal<InstallState>;

export function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  throw new Error('not implemented');
}

/** True when running as an installed app. */
export function isStandalone(): boolean {
  throw new Error('not implemented');
}
