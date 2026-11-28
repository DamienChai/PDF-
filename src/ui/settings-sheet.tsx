/** Settings: language, theme, output names and options, installation, about. */
import { useId } from 'preact/hooks';
import { t } from '../i18n';
import { outputFileName } from '../lib/filename';
import {
  DEFAULT_SETTINGS,
  MAX_SUFFIX_LENGTH,
  OPEN_SOURCE_COMPONENTS,
  THIRD_PARTY_NOTICES_URL,
  aboutInfo,
  closeOverlay,
  installState,
  overlay,
  promptInstall,
  settings,
  updateSettings,
  type Settings,
} from '../state';
import { Icon } from './icons';
import { literalEntry } from './password-input';
import { Prose } from './prose';
import { Segmented } from './segmented';
import { Sheet } from './sheet';
import { SwitchRow } from './switch';

const LANGUAGES: readonly Settings['language'][] = ['auto', 'zh-CN', 'en'];
const THEMES = [
  { value: 'system', icon: 'auto' },
  { value: 'light', icon: 'sun' },
  { value: 'dark', icon: 'moon' },
] as const;

function SuffixField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  const id = useId();
  return (
    <div class="field">
      <label class="label" for={id}>
        {label}
      </label>
      <div class="input">
        <input
          ref={literalEntry}
          id={id}
          class="input__control input__control--mono"
          type="text"
          value={value}
          maxLength={MAX_SUFFIX_LENGTH}
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          enterkeyhint="done"
          onInput={(event) => onChange(event.currentTarget.value)}
          // What was typed may have been normalised (illegal characters dropped): show the result.
          onBlur={(event) => {
            event.currentTarget.value = value;
          }}
        />
      </div>
    </div>
  );
}

function About() {
  const about = aboutInfo.value;
  let engine: string;
  if (about.qpdfVersion) {
    engine = t('about.engine.value', { version: about.qpdfVersion });
    if (about.compatibilityMode) engine += ` · ${t('about.engine.compatibility')}`;
  } else if (about.engineStatus === 'unavailable') engine = t('about.engine.unavailable');
  else engine = t('about.engine.loading');

  return (
    <section class="sheet__section" aria-labelledby="settings-about">
      <h3 class="section-title" id="settings-about">
        {t('about.title')}
      </h3>
      <div class="rows">
        <div class="row">
          <span class="row__title">{t('about.version')}</span>
          <span class="row__value mono">{about.appVersion}</span>
        </div>
        <div class="row">
          <span class="row__title">{t('about.engine')}</span>
          <span class="row__value mono">{engine}</span>
        </div>
        <p class="notice rows__note">
          <Icon name="shield" size="sm" />
          <span>
            <Prose text={t('about.privacy')} />
          </span>
        </p>
        <details class="licenses">
          <summary class="row licenses__summary">
            <span class="row__title">{t('about.licenses')}</span>
            <Icon name="chevron-down" />
          </summary>
          <div class="licenses__body">
            <p class="hint">
              <Prose text={t('about.licenses.app')} />
            </p>
            <p class="hint">{t('about.licenses.thirdParty')}</p>
            <ul class="licenses__list">
              {OPEN_SOURCE_COMPONENTS.map((component) => (
                <li key={component.name}>
                  <span class="licenses__name">
                    {component.name}
                    {component.version && <span class="mono"> {component.version}</span>}
                  </span>
                  <span class="licenses__license mono">{component.license}</span>
                </li>
              ))}
            </ul>
            <p class="hint">
              <Prose text={t('about.licenses.ijg')} />
            </p>
            {/* A new tab or window: the list of files stays where it is. */}
            <a
              class="link-btn licenses__notices"
              href={THIRD_PARTY_NOTICES_URL}
              target="_blank"
              rel="noopener"
            >
              {t('about.licenses.notices')}
            </a>
          </div>
        </details>
      </div>
    </section>
  );
}

function Install() {
  const state = installState.value;
  return (
    <div class="row row--install">
      <div class="row__text">
        <span class="row__title">{t('settings.install')}</span>
        <span class="row__desc">
          <Prose
            text={t(
              state === 'unavailable' ? 'settings.install.hint' : 'settings.install.description',
            )}
          />
        </span>
      </div>
      {state === 'available' && (
        <button
          type="button"
          class="btn btn--secondary btn--sm"
          onClick={() => void promptInstall()}
        >
          <Icon name="install" size="sm" />
          {t('topbar.install')}
        </button>
      )}
      {state === 'installed' && (
        <span class="mark mark--allowed">
          <Icon name="check" size="sm" />
          {t('settings.install.installed')}
        </span>
      )}
    </div>
  );
}

function Content() {
  const current = settings.value;
  const id = useId();
  const sample = outputFileName(t('settings.naming.sample'), 'decrypt', current.naming);
  const customNaming =
    current.naming.decryptSuffix !== DEFAULT_SETTINGS.naming.decryptSuffix ||
    current.naming.encryptSuffix !== DEFAULT_SETTINGS.naming.encryptSuffix;
  return (
    <>
      <div class="rows">
        <div class="row row--stack">
          <span class="row__title" id={`${id}-language`}>
            {t('settings.language')}
          </span>
          <Segmented
            labelledBy={`${id}-language`}
            value={current.language}
            onChange={(language) => updateSettings({ language })}
            options={LANGUAGES.map((value) => ({
              value,
              label: t({ key: `settings.language.${value}` }),
            }))}
          />
        </div>
        <div class="row row--stack">
          <span class="row__title" id={`${id}-theme`}>
            {t('settings.theme')}
          </span>
          <Segmented
            labelledBy={`${id}-theme`}
            value={current.theme}
            onChange={(theme) => updateSettings({ theme })}
            options={THEMES.map(({ value, icon }) => ({
              value,
              icon,
              label: t({ key: `settings.theme.${value}` }),
            }))}
          />
        </div>
      </div>

      <section class="sheet__section" aria-labelledby={`${id}-naming`}>
        <h3 class="section-title" id={`${id}-naming`}>
          {t('settings.naming')}
        </h3>
        <div class="rows">
          <div class="suffixes">
            <SuffixField
              label={t('settings.naming.decryptSuffix')}
              value={current.naming.decryptSuffix}
              onChange={(decryptSuffix) => updateSettings({ naming: { decryptSuffix } })}
            />
            <SuffixField
              label={t('settings.naming.encryptSuffix')}
              value={current.naming.encryptSuffix}
              onChange={(encryptSuffix) => updateSettings({ naming: { encryptSuffix } })}
            />
          </div>
          <div class="row">
            <span class="row__desc suffixes__preview">
              {t('settings.naming.preview', { name: sample })}
            </span>
            <button
              type="button"
              class="link-btn"
              disabled={!customNaming}
              onClick={() => updateSettings({ naming: { ...DEFAULT_SETTINGS.naming } })}
            >
              {t('settings.naming.reset')}
            </button>
          </div>
        </div>
      </section>

      <section class="sheet__section" aria-labelledby={`${id}-output`}>
        <h3 class="section-title" id={`${id}-output`}>
          {t('settings.output')}
        </h3>
        <div class="rows">
          <SwitchRow
            title={t('settings.autoSave')}
            description={t('settings.autoSave.description')}
            checked={current.autoSave}
            onChange={(autoSave) => updateSettings({ autoSave })}
          />
          <SwitchRow
            title={t('settings.output.optimize')}
            description={t('settings.output.optimize.description')}
            checked={current.output.optimizeSize}
            onChange={(optimizeSize) => updateSettings({ output: { optimizeSize } })}
          />
          <SwitchRow
            title={t('settings.output.linearize')}
            description={t('settings.output.linearize.description')}
            checked={current.output.linearize}
            onChange={(linearize) => updateSettings({ output: { linearize } })}
          />
        </div>
      </section>

      <div class="rows">
        <Install />
      </div>

      <About />
    </>
  );
}

export function SettingsSheet() {
  const open = overlay.value?.kind === 'settings';
  return (
    <Sheet open={open} onClose={closeOverlay} title={t('settings.title')}>
      <Content />
    </Sheet>
  );
}
