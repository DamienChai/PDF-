/**
 * Building blocks of the action area: its status line, the primary button with its double-tap
 * guard, and the progress of the running batch.
 */
import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import { formatPercent } from '../i18n';
import { jobs } from '../state';
import { Progress } from './chips';
import { Icon, type IconName } from './icons';

export const UNLOCK_FIELD_ID = 'unlock-password';

export function unlockField(): HTMLInputElement | null {
  return document.getElementById(UNLOCK_FIELD_ID) as HTMLInputElement | null;
}

/**
 * Guards against a double tap whose second tap lands on a button that has just taken the place
 * of the one that was pressed: "Unlock" must not continue into "Save" or "Cancel". A press is
 * ignored when it follows, within half a second, a press on a button that did something else.
 * Only pointer presses count; a click that comes from the keyboard (Enter in a field, Space on
 * the button) has `detail` 0.
 */
export type TapGuard = (action?: () => void) => (event: MouseEvent) => void;

const DOUBLE_TAP_MS = 500;

export function useTapGuard(identity: string): TapGuard {
  const last = useRef({ identity: '', at: Number.NEGATIVE_INFINITY });
  return (action) => (event) => {
    if (event.detail > 0) {
      const now = performance.now();
      if (last.current.identity !== identity && now - last.current.at < DOUBLE_TAP_MS) {
        // Also keeps a submit button from submitting.
        event.preventDefault();
        return;
      }
      last.current = { identity, at: now };
    }
    action?.();
  };
}

interface StatusProps {
  icon?: IconName;
  spin?: boolean;
  /** `note`: a sentence that may wrap, rather than a one-line headline. */
  tone?: 'default' | 'quiet' | 'danger' | 'success' | 'note';
  /** The line labels this field. */
  labelFor?: string;
  aside?: ComponentChildren;
  children: ComponentChildren;
}

export function Status({ icon, spin, tone = 'default', labelFor, aside, children }: StatusProps) {
  const content = (
    <>
      {icon && <Icon name={icon} size="sm" spin={spin ?? false} />}
      <span>{children}</span>
    </>
  );
  return (
    <div class={`dock__status dock__status--${tone}`}>
      {labelFor ? (
        <label class="dock__headline" for={labelFor}>
          {content}
        </label>
      ) : (
        <p class="dock__headline">{content}</p>
      )}
      {aside && <span class="dock__aside">{aside}</span>}
    </div>
  );
}

export function PrimaryButton({
  label,
  icon,
  disabled = false,
  softDisabled = false,
  submit = false,
  onClick,
  variant = 'primary',
  keepFocus = false,
}: {
  label: string;
  icon?: IconName;
  disabled?: boolean;
  /** Looks unavailable but still reacts: pressing it points to what is missing. */
  softDisabled?: boolean;
  /** Submits the form, i.e. runs the primary action of the mode. */
  submit?: boolean;
  onClick: (event: MouseEvent) => void;
  variant?: 'primary' | 'secondary';
  /**
   * Pressing the button leaves the focus in the password field: the on-screen keyboard stays
   * up while the password is tried, and a wrong one can be corrected at once.
   */
  keepFocus?: boolean;
}) {
  return (
    <button
      type={submit ? 'submit' : 'button'}
      class={`btn btn--${variant} btn--cta btn--block`}
      disabled={disabled}
      aria-disabled={softDisabled || undefined}
      onClick={onClick}
      onMouseDown={
        keepFocus
          ? (event) => {
              if (document.activeElement === unlockField()) event.preventDefault();
            }
          : undefined
      }
    >
      {icon && <Icon name={icon} class="btn__icon" />}
      <span class="btn__label">{label}</span>
    </button>
  );
}

export function OverallPercent() {
  return <span class="num">{formatPercent(jobs.overallProgress.value)}</span>;
}

export function OverallProgress({ class: extra }: { class?: string }) {
  return (
    <div class={extra}>
      <Progress value={jobs.overallProgress.value} />
    </div>
  );
}
