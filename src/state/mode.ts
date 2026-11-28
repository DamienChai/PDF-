/** The two modes of the app. Its own module so that state modules can share it without cycles. */
import { signal, type ReadonlySignal } from '@preact/signals';

export type Mode = 'unlock' | 'lock';

export const DEFAULT_MODE: Mode = 'unlock';

/** The mode named by `?mode=lock` / `?mode=unlock` (app shortcuts), or null. */
export function modeFromUrl(url: string | URL | null | undefined): Mode | null {
  if (!url) return null;
  try {
    const value = new URL(url, 'https://app.invalid/').searchParams.get('mode');
    return value === 'lock' || value === 'unlock' ? value : null;
  } catch {
    return null;
  }
}

function initialMode(): Mode {
  if (typeof location === 'undefined') return DEFAULT_MODE;
  return modeFromUrl(location.href) ?? DEFAULT_MODE;
}

const current = signal<Mode>(initialMode());

/** The current mode. Switching it keeps the loaded files; each mode has its own results. */
export const mode: ReadonlySignal<Mode> = current;

export function setMode(next: Mode): void {
  current.value = next;
}
