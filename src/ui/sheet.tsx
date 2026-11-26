/**
 * A modal surface: a bottom sheet on the phone, a centred dialog from 720px. It traps the
 * focus, closes on Escape, on a tap on the scrim and by dragging it down, and gives the focus
 * back to whatever opened it. The Android back gesture is handled by the overlay state, which
 * simply flips `open`.
 */
import type { ComponentChildren, TargetedPointerEvent } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { rememberFocus, trapTab } from './focus';
import { Icon } from './icons';

export interface SheetProps {
  open: boolean;
  onClose(): void;
  title: string;
  /** A small line above the title, e.g. "File details" above the file name. */
  eyebrow?: string;
  /** `actions`: a short list of commands; hugs its content. */
  variant?: 'panel' | 'actions';
  children: ComponentChildren;
}

/** How long the closing animation takes; the content stays mounted for that long. */
const EXIT_MS = 220;
/** Dragged further down than this, or flicked faster, the sheet closes. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 0.6;

let openSheets = 0;

function lockPage(locked: boolean): void {
  openSheets += locked ? 1 : -1;
  const active = openSheets > 0;
  document.documentElement.classList.toggle('is-locked', active);
  // Everything behind the sheet is out of reach for the keyboard and for assistive technology.
  document.getElementById('page')?.toggleAttribute('inert', active);
}

export function Sheet({ open, onClose, title, eyebrow, variant = 'panel', children }: SheetProps) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Presence: stay mounted while the closing animation runs.
  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // Focus goes in when the sheet appears and back to the opener when it is gone.
  useLayoutEffect(() => {
    if (!mounted) return;
    const restore = rememberFocus();
    lockPage(true);
    surface.current?.focus({ preventScroll: true });
    return () => {
      lockPage(false);
      restore();
    };
  }, [mounted]);

  const drag = useRef<{ startY: number; lastY: number; lastTime: number; velocity: number } | null>(
    null,
  );

  function onPointerDown(event: TargetedPointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // The close button inside the header is a button, not a handle.
    if ((event.target as HTMLElement).closest('button')) return;
    const element = surface.current;
    // Only the bottom sheet can be dragged away; the dialog is centred with a transform.
    if (
      !element ||
      getComputedStyle(element).getPropertyValue('--sheet-draggable').trim() !== '1'
    ) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      startY: event.clientY,
      lastY: event.clientY,
      lastTime: event.timeStamp,
      velocity: 0,
    };
    element.style.transition = 'none';
  }

  function onPointerMove(event: TargetedPointerEvent<HTMLDivElement>): void {
    const state = drag.current;
    const element = surface.current;
    if (!state || !element) return;
    const elapsed = Math.max(1, event.timeStamp - state.lastTime);
    state.velocity = (event.clientY - state.lastY) / elapsed;
    state.lastY = event.clientY;
    state.lastTime = event.timeStamp;
    element.style.transform = `translateY(${Math.max(0, event.clientY - state.startY)}px)`;
  }

  function onPointerEnd(): void {
    const state = drag.current;
    const element = surface.current;
    if (!state || !element) return;
    drag.current = null;
    const distance = Math.max(0, state.lastY - state.startY);
    element.style.transition = '';
    if (distance > DISMISS_DISTANCE || (distance > 24 && state.velocity > DISMISS_VELOCITY)) {
      // Continue from where the finger left it.
      element.style.setProperty('--sheet-from', `${distance}px`);
      element.style.transform = '';
      onClose();
    } else {
      element.style.transform = '';
    }
  }

  if (!mounted) return null;

  return (
    <div class={`modal${closing ? ' is-closing' : ''}`}>
      <div class="scrim" onClick={onClose} />
      <div
        ref={surface}
        class={`sheet sheet--${variant}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          } else {
            trapTab(event, event.currentTarget);
          }
        }}
      >
        <div
          class="sheet__header"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <span class="sheet__grabber" aria-hidden="true" />
          <div class="sheet__titles">
            {eyebrow && <p class="sheet__eyebrow">{eyebrow}</p>}
            <h2 class="sheet__title" id={titleId}>
              {title}
            </h2>
          </div>
          <button
            type="button"
            class="icon-btn sheet__close"
            aria-label={t('aria.close')}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </div>
        <div class="sheet__body">{children}</div>
      </div>
    </div>
  );
}

/** The last value that was not null: content for an overlay while it animates out. */
export function useLast<T>(value: T | null): T | null {
  const last = useRef<T | null>(value);
  if (value !== null) last.current = value;
  return last.current;
}
