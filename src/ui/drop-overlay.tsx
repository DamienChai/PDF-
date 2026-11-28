/** The full-window target shown while files are dragged over the app. */
import { t } from '../i18n';
import { dragActive } from '../state';
import { Icon } from './icons';

export function DropOverlay() {
  if (!dragActive.value) return null;
  return (
    // Never a target itself: the window receives the drop (see src/state/intake.ts).
    <div class="drop" aria-hidden="true">
      <div class="drop__frame">
        <Icon name="file-plus" class="drop__icon" />
        <p class="drop__title">{t('drop.title')}</p>
        <p class="drop__text">
          <Icon name="shield" size="sm" />
          {t('drop.subtitle')}
        </p>
      </div>
    </div>
  );
}
