/** The top bar: brand, mode switch, install and settings. */
import { useEffect } from 'preact/hooks';
import { t } from '../i18n';
import { installState, mode, openSettings, promptInstall, setMode, type Mode } from '../state';
import { BrandMark, Icon } from './icons';
import { Segmented } from './segmented';

export function TopBar() {
  // Pinned bars get an edge once content scrolls underneath them (see shell.css, files.css).
  useEffect(() => {
    const root = document.documentElement;
    const update = (): void => {
      root.toggleAttribute('data-scrolled', window.scrollY > 4);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  return (
    <header class="topbar">
      <div class="topbar__inner">
        <h1 class="brand">
          <BrandMark class="brand__mark" />
          <span class="brand__name">{t('app.name')}</span>
        </h1>
        <Segmented<Mode>
          class="topbar__mode"
          label={t('mode.label')}
          value={mode.value}
          onChange={setMode}
          options={[
            { value: 'unlock', label: t('mode.unlock'), icon: 'unlock' },
            { value: 'lock', label: t('mode.lock'), icon: 'lock' },
          ]}
        />
        <div class="topbar__actions">
          {installState.value === 'available' && (
            <button
              type="button"
              class="btn btn--secondary btn--sm btn--header install-btn"
              onClick={() => void promptInstall()}
            >
              <Icon name="install" size="sm" />
              {t('topbar.install')}
            </button>
          )}
          <button
            type="button"
            class="icon-btn"
            aria-label={t('topbar.settings')}
            aria-haspopup="dialog"
            onClick={openSettings}
          >
            <Icon name="settings" />
          </button>
        </div>
      </div>
    </header>
  );
}
