/**
 * A file name on one line. When it does not fit it is shortened in the middle, so that the end
 * of the name and the extension stay visible: `2024年度财务报…终版(3).pdf`.
 *
 * The cut is measured, not left to CSS: two flex items with `text-overflow` leave a visible gap
 * between the ellipsis and the tail.
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { splitExtension } from '../lib/filename';

const ELLIPSIS = '…';
/** Characters of the name kept in front of the extension. */
const TAIL_CHARACTERS = 9;

let context: CanvasRenderingContext2D | null | undefined;

function measurer(): CanvasRenderingContext2D | null {
  if (context === undefined) {
    context =
      typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  return context;
}

/** Shortens `name` to `maxWidth` pixels as measured by `width`; exported for clarity of the rule. */
export function truncateMiddle(
  name: string,
  maxWidth: number,
  width: (text: string) => number,
): string {
  if (maxWidth <= 0 || width(name) <= maxWidth) return name;
  const { base, ext } = splitExtension(name);
  // By code point: never half of a surrogate pair.
  const head = Array.from(base);
  const tailLength = Math.min(TAIL_CHARACTERS, Math.floor(head.length / 2));
  let tail = head.splice(head.length - tailLength, tailLength).join('') + ext;
  // A tail that alone is too wide (narrow column, long extension) gives way from its start.
  while (tail.length > ext.length + 1 && width(`${ELLIPSIS}${tail}`) > maxWidth * 0.7) {
    tail = Array.from(tail).slice(1).join('');
  }
  let low = 0;
  let high = head.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (width(`${head.slice(0, middle).join('')}${ELLIPSIS}${tail}`) <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return `${head.slice(0, low).join('').trimEnd()}${ELLIPSIS}${tail}`;
}

type Listener = () => void;
const listeners = new WeakMap<Element, Listener>();
let observer: ResizeObserver | undefined;

/** One observer for every name in the list. */
function onResize(element: Element, listener: Listener): () => void {
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) listeners.get(entry.target)?.();
  });
  listeners.set(element, listener);
  observer.observe(element);
  return () => {
    listeners.delete(element);
    observer?.unobserve(element);
  };
}

export function FileName({ name, class: extra }: { name: string; class?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(name);

  useLayoutEffect(() => {
    const element = ref.current;
    const canvas = measurer();
    if (!element || !canvas) return;
    const fit = (): void => {
      const style = getComputedStyle(element);
      canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      // One pixel of slack for sub-pixel differences between canvas and layout.
      const available = element.clientWidth - 1;
      setShown(truncateMiddle(name, available, (text) => canvas.measureText(text).width));
    };
    fit();
    return onResize(element, fit);
  }, [name]);

  return (
    <span
      ref={ref}
      class={`filename${extra ? ` ${extra}` : ''}`}
      title={shown === name ? undefined : name}
    >
      {/* Assistive technology gets the whole name; the shortened one is for the eye. */}
      <span class="sr-only">{name}</span>
      <span class="filename__text" aria-hidden="true">
        {shown}
      </span>
    </span>
  );
}
