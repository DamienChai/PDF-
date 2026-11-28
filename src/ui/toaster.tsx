/**
 * Toasts. One at a time, in one place and one width: above the action area on the phone,
 * bottom centre on desktop. Newer messages cover older ones; a sticky one (update available)
 * comes back when what covered it has gone.
 */
import { useEffect } from 'preact/hooks';
import { t } from '../i18n';
import { toasts } from '../state';
import { Icon, type IconName } from './icons';
import { Prose } from './prose';

const TONE_ICON: Readonly<Record<string, IconName | undefined>> = {
  success: 'check',
  error: 'alert',
};

export function Toaster() {
  const queue = toasts.toasts.value;
  const toast = queue[queue.length - 1];
  const icon = toast ? TONE_ICON[toast.tone] : undefined;
  const visible = toast !== undefined;

  // The page keeps a slot free for the toast while there is one (scroll padding, overlays.css).
  useEffect(() => {
    document.documentElement.toggleAttribute('data-toast', visible);
  }, [visible]);

  return (
    // Not a live region itself: the announcer speaks every message, also the covered ones.
    <div class="toasts" role="region" aria-label={t('aria.notifications')}>
      {toast && (
        <div
          key={toast.id}
          class={`toast toast--${toast.tone}`}
          onPointerEnter={() => toasts.pause(toast.id)}
          onPointerLeave={() => toasts.resume(toast.id)}
          onFocusIn={() => toasts.pause(toast.id)}
          onFocusOut={() => toasts.resume(toast.id)}
        >
          {icon && <Icon name={icon} size="sm" class="toast__icon" />}
          <p class="toast__text">
            <Prose text={t(toast.message)} />
          </p>
          {toast.action && (
            <button type="button" class="toast__action" onClick={() => toasts.runAction(toast.id)}>
              {t(toast.action.label)}
            </button>
          )}
          <button
            type="button"
            class="icon-btn toast__close"
            aria-label={t('toast.dismiss')}
            onClick={() => toasts.dismiss(toast.id)}
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      )}
    </div>
  );
}
