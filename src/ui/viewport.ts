/**
 * What the layout needs to know about the window: which of the three layouts applies, whether
 * the on-screen keyboard is open, and how tall the sticky action area is.
 *
 * CSS does the layout; these signals exist for the few decisions markup has to make (a bottom
 * sheet or a dialog, one large card or a list) and for the `data-compact` attribute, which CSS
 * cannot derive by itself: a media query sees a short viewport, not "the keyboard just opened".
 */
import { computed, signal, type ReadonlySignal } from '@preact/signals';

function media(query: string): ReadonlySignal<boolean> {
  if (typeof matchMedia !== 'function') return signal(false);
  const list = matchMedia(query);
  const state = signal(list.matches);
  list.addEventListener('change', () => {
    state.value = list.matches;
  });
  return state;
}

/** Two panes: the file list and the inspector. Below this the action area is a bottom bar. */
export const isDesktop: ReadonlySignal<boolean> = media('(min-width: 960px)');

/** Overlays are bottom sheets; from this width up they are dialogs and popovers. */
export const isSheetLayout: ReadonlySignal<boolean> = media('(max-width: 719.98px)');

const coarsePointer = media('(pointer: coarse)');

/** Viewports this short have no room for the full action area even without a keyboard. */
const SHORT_VIEWPORT = 560;
/** The keyboard takes far more than this; the browser's collapsing toolbars take less. */
const KEYBOARD_MIN_HEIGHT = 140;

function currentHeight(): number {
  if (typeof window === 'undefined') return 0;
  // Where the keyboard does not resize the layout viewport (iOS), the visual viewport shrinks.
  return Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight);
}

const height = signal(currentHeight());
const width = signal(typeof window === 'undefined' ? 0 : window.innerWidth);
/** The tallest the viewport has been at the current width: its height without a keyboard. */
const fullHeight = signal(height.peek());

/** The on-screen keyboard is (very probably) open. */
export const keyboardOpen: ReadonlySignal<boolean> = computed(
  () => coarsePointer.value && height.value < fullHeight.value - KEYBOARD_MIN_HEIGHT,
);

/**
 * Little vertical room on a phone-sized layout: the action area collapses to one row and the
 * header scrolls away. Tied to the keyboard, not to a height threshold alone, so the layout does
 * not flip back and forth while the keyboard changes its height.
 */
export const compact: ReadonlySignal<boolean> = computed(
  () => !isDesktop.value && (keyboardOpen.value || height.value <= SHORT_VIEWPORT),
);

/** Keyboard shortcuts are written with ⌘ on Apple platforms. */
export const isApplePlatform: boolean =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? '');

function measure(): void {
  const nextWidth = window.innerWidth;
  const nextHeight = currentHeight();
  if (nextWidth !== width.peek()) {
    // Rotated or resized sideways: what "full height" means has changed.
    width.value = nextWidth;
    fullHeight.value = nextHeight;
  } else if (nextHeight > fullHeight.peek()) {
    fullHeight.value = nextHeight;
  }
  height.value = nextHeight;
}

let watching = false;

/** Starts following the window. Call once, before the first render. */
export function watchViewport(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('resize', measure);
  window.visualViewport?.addEventListener('resize', measure);
  const root = document.documentElement;
  const apply = (): void => {
    root.toggleAttribute('data-compact', compact.value);
  };
  compact.subscribe(apply);
}

/**
 * Publishes the height of the sticky action area as `--dock-h` on the root element, for scroll
 * padding and for the position of toasts. Returns a function that stops doing so.
 */
export function publishDockHeight(element: HTMLElement): () => void {
  const root = document.documentElement;
  const update = (): void => {
    // Only where the area is pinned to the bottom edge (phone and tablet, see shell.css).
    const pinned = getComputedStyle(element).getPropertyValue('--dock-pinned').trim() === '1';
    root.style.setProperty('--dock-h', pinned ? `${Math.round(element.offsetHeight)}px` : '0px');
  };
  update();
  const observer = new ResizeObserver(update);
  observer.observe(element);
  window.addEventListener('resize', update);
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', update);
    root.style.setProperty('--dock-h', '0px');
  };
}
