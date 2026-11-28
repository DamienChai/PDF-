/**
 * No files yet: one large, obvious target. On the phone the stage is a card that picks files
 * when tapped and the button sits in the action area at the bottom edge; on desktop both are
 * one centred drop target.
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import { t } from '../i18n';
import { mode, pickFiles } from '../state';
import { Illustration } from './artwork';
import { Icon } from './icons';
import { isApplePlatform, publishDockHeight } from './viewport';

export function EmptyState() {
  const lock = mode.value === 'lock';
  const cta = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (cta.current ? publishDockHeight(cta.current) : undefined), []);

  return (
    // The whole target picks files when clicked: a convenience for pointer and touch. The
    // button inside it is the control; clicks in its area are its own business.
    <div
      class="empty"
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest('.empty__cta')) pickFiles();
      }}
    >
      <div class="empty__hero">
        <Illustration kind={lock ? 'lock' : 'unlock'} class="empty__art" />
        <h2 class="empty__title">{t(lock ? 'empty.lock.title' : 'empty.unlock.title')}</h2>
        <p class="empty__text">{t(lock ? 'empty.lock.body' : 'empty.unlock.body')}</p>
        <ul class="empty__facts">
          <li class="chip chip--fact">{t('empty.chip.aes256')}</li>
          <li class="chip chip--plain">{t('empty.chip.batch')}</li>
          <li class="chip chip--plain">{t('empty.chip.offline')}</li>
        </ul>
      </div>
      <div class="empty__cta" ref={cta}>
        <p class="privacy">
          <Icon name="shield" size="sm" />
          {t('empty.privacy')}
        </p>
        <button type="button" class="btn btn--primary btn--cta btn--block" onClick={pickFiles}>
          {t('empty.choose')}
        </button>
        <p class="empty__hint">
          <span>{t('empty.dropHint')}</span>
          <span aria-hidden="true">·</span>
          <span>{t('empty.pasteHint')}</span>
          <kbd class="kbd">{isApplePlatform ? '⌘' : 'Ctrl'}</kbd>
          <kbd class="kbd">V</kbd>
        </p>
      </div>
    </div>
  );
}
