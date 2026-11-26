/** A segmented control: a radio group whose thumb slides to the selected option. */
import type { TargetedKeyboardEvent } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { Icon, type IconName } from './icons';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange(value: T): void;
  /** Accessible name of the group; alternatively the id of a visible label. */
  label?: string;
  labelledBy?: string;
  class?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  labelledBy,
  class: extra,
}: SegmentedProps<T>) {
  const group = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  // Options are as wide as their labels need, so the thumb is placed by measuring the selected
  // one. It is measured again whenever the control changes size (language, window).
  useLayoutEffect(() => {
    const root = group.current;
    const marker = thumb.current;
    if (!root || !marker) return;
    const place = (): void => {
      const selected = root.querySelector<HTMLElement>('[aria-checked="true"]');
      if (!selected) return;
      marker.style.width = `${selected.offsetWidth}px`;
      marker.style.transform = `translateX(${selected.offsetLeft}px)`;
    };
    place();
    // Slide only after the first placement: nothing should move when the control appears.
    const frame = requestAnimationFrame(() => marker.setAttribute('data-ready', ''));
    const observer = new ResizeObserver(place);
    observer.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [index, options.map((option) => option.label).join('\n')]);

  function onKeyDown(event: TargetedKeyboardEvent<HTMLDivElement>): void {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    let next = index;
    if (step !== 0) next = (index + step + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else return;
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    // Roving focus: the selected radio is the one that is focused.
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons[next]?.focus();
  }

  return (
    <div
      ref={group}
      class={`segmented${extra ? ` ${extra}` : ''}`}
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
    >
      <span class="segmented__thumb" ref={thumb} aria-hidden="true" />
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            class="segmented__option"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
          >
            {option.icon && <Icon name={option.icon} size="sm" />}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
