/**
 * The overflow menu of a file: details, process again, remove. A bottom action sheet on the
 * phone (within reach of the thumb), a popover anchored to its button on desktop. Which file it
 * belongs to is overlay state, so the back gesture closes it like any sheet.
 */
import type { TargetedKeyboardEvent } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { t } from '../i18n';
import { closeOverlay, jobs, menuEntry, openDetails, type Entry } from '../state';
import { rememberFocus } from './focus';
import { Icon, type IconName } from './icons';
import { Sheet, useLast } from './sheet';
import { isSheetLayout } from './viewport';

interface Item {
  id: string;
  label: string;
  icon: IconName;
  danger?: boolean;
  run(): void;
}

function itemsFor(entry: Entry): Item[] {
  const view = entry.view.value;
  const items: Item[] = [];
  items.push({
    id: 'details',
    label: t('entry.menu.details'),
    icon: 'info',
    // Replaces the menu in place: one history entry for both.
    run: () => openDetails(entry.id),
  });
  if (view.canRedo) {
    items.push({
      id: 'redo',
      label: t('entry.menu.redo'),
      icon: 'redo',
      run: () => {
        closeOverlay();
        jobs.redo(entry.id);
      },
    });
  }
  if (view.canRetry) {
    items.push({
      id: 'retry',
      label: t('entry.retry'),
      icon: 'redo',
      run: () => {
        closeOverlay();
        jobs.retry(entry.id);
      },
    });
  }
  items.push({
    id: 'remove',
    label: t('entry.menu.remove'),
    icon: 'trash',
    danger: true,
    run: () => {
      closeOverlay();
      jobs.remove(entry.id);
    },
  });
  return items;
}

function MenuItems({
  items,
  onKeyDown,
}: {
  items: Item[];
  onKeyDown?: (event: TargetedKeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div class="menu__items" role="menu" onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          class={`menu__item${item.danger ? ' menu__item--danger' : ''}`}
          onClick={item.run}
        >
          <Icon name={item.icon} />
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Arrow keys move between the items, as in any menu. */
function roveFocus(event: TargetedKeyboardEvent<HTMLDivElement>): void {
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  );
  const index = buttons.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
  else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  if (next < 0) return;
  event.preventDefault();
  buttons[next]?.focus();
}

function Popover({ entry }: { entry: Entry }) {
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = menu.current;
    const anchor = document.querySelector<HTMLElement>(`[data-menu-anchor="${entry.id}"]`);
    if (!element || !anchor) {
      closeOverlay();
      return;
    }
    const restore = rememberFocus();
    const rect = anchor.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = element;
    const margin = 8;
    // Under the button, right edges aligned; above it when there is no room below.
    const below = rect.bottom + 4;
    const top = below + height + margin > window.innerHeight ? rect.top - 4 - height : below;
    const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin);
    // Set directly: the first item can only take the focus once the menu is visible.
    element.style.top = `${Math.max(margin, top)}px`;
    element.style.left = `${left}px`;
    element.style.visibility = 'visible';
    element.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });

    const dismiss = (event: Event): void => {
      if (
        event.target instanceof Node &&
        (element.contains(event.target) || anchor.contains(event.target))
      ) {
        return;
      }
      closeOverlay();
    };
    // The page moving under a fixed popover would leave it pointing at nothing. Only a scroll
    // that moves it counts: the event of a scroll that ended just before the menu opened (the
    // button was brought into view and pressed at once, as assistive technology does) arrives
    // after it and must not close it again.
    const { scrollX, scrollY } = window;
    const onScroll = (): void => {
      if (window.scrollX !== scrollX || window.scrollY !== scrollY) closeOverlay();
    };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', closeOverlay);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', closeOverlay);
      restore();
    };
  }, [entry.id]);

  return (
    <div
      ref={menu}
      class="menu"
      style={{ visibility: 'hidden' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          closeOverlay();
        }
      }}
    >
      <MenuItems items={itemsFor(entry)} onKeyDown={roveFocus} />
    </div>
  );
}

export function FileMenu() {
  const entry = menuEntry.value;
  const last = useLast(entry);
  if (isSheetLayout.value) {
    return (
      <Sheet
        open={entry !== null}
        onClose={closeOverlay}
        title={last?.name ?? ''}
        variant="actions"
      >
        {last && <MenuItems items={itemsFor(last)} onKeyDown={roveFocus} />}
      </Sheet>
    );
  }
  return entry ? <Popover entry={entry} key={entry.id} /> : null;
}
