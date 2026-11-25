/**
 * User settings: kept in localStorage, validated field by field when read, synchronised between
 * tabs, and applied to the document (theme, language, browser UI colour).
 *
 * public/boot.js applies the same theme and language before first paint, without this bundle. The
 * two must agree; `settings.test.ts` runs both against the same fake document.
 */
import { computed, effect, signal, type ReadonlySignal } from '@preact/signals';
import type { OutputOptions } from '../engine/types';
import { isLocale, resolveLocale, type LanguageSetting, type Locale } from '../i18n/locale';
import { DEFAULT_NAMING, type NamingOptions } from '../lib/filename';

export const SETTINGS_KEY = 'pdfkey:settings';

export type ThemeSetting = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export interface OutputSettings {
  /** Compress streams and pack objects: usually a smaller file, a little slower. */
  optimizeSize: boolean;
  /** Linearize the output ("fast web view"). */
  linearize: boolean;
}

export interface Settings {
  theme: ThemeSetting;
  language: LanguageSetting;
  naming: NamingOptions;
  /** Deliver results to the download folder as soon as processing finishes. */
  autoSave: boolean;
  output: OutputSettings;
}

export interface SettingsPatch {
  theme?: ThemeSetting;
  language?: LanguageSetting;
  naming?: Partial<NamingOptions>;
  autoSave?: boolean;
  output?: Partial<OutputSettings>;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  theme: 'system',
  language: 'auto',
  naming: DEFAULT_NAMING,
  autoSave: false,
  output: Object.freeze({ optimizeSize: false, linearize: false }),
});

/** Page background of each theme; shown by the browser UI / status bar (`theme-color`). */
export const THEME_COLORS: Readonly<Record<ResolvedTheme, string>> = Object.freeze({
  light: '#F7F7FB',
  dark: '#111318',
});

/** Longest file-name suffix that is accepted, in UTF-16 units. */
export const MAX_SUFFIX_LENGTH = 32;

const DARK_QUERY = '(prefers-color-scheme: dark)';
const THEME_COLOR_SELECTOR = 'meta[name="theme-color"]';

// Characters that can never be part of a file name; the same set src/lib/filename.ts replaces.
const SUFFIX_ILLEGAL = /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/g;

/** What a suffix typed into the settings is reduced to before it is stored. */
export function normalizeSuffix(value: string): string {
  return value.replace(SUFFIX_ILLEGAL, '').slice(0, MAX_SUFFIX_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function suffixOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length <= MAX_SUFFIX_LENGTH
    ? normalizeSuffix(value)
    : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Builds valid settings from anything: every field that is missing or has an unexpected value is
 * taken from `fallback`, and unknown fields are dropped.
 */
export function parseSettings(raw: unknown, fallback: Settings = DEFAULT_SETTINGS): Settings {
  const source = isRecord(raw) ? raw : {};
  const naming = isRecord(source.naming) ? source.naming : {};
  const output = isRecord(source.output) ? source.output : {};
  const { theme, language } = source;
  return {
    theme: theme === 'system' || theme === 'light' || theme === 'dark' ? theme : fallback.theme,
    language: language === 'auto' || isLocale(language) ? language : fallback.language,
    naming: {
      decryptSuffix: suffixOr(naming.decryptSuffix, fallback.naming.decryptSuffix),
      encryptSuffix: suffixOr(naming.encryptSuffix, fallback.naming.encryptSuffix),
    },
    autoSave: booleanOr(source.autoSave, fallback.autoSave),
    output: {
      optimizeSize: booleanOr(output.optimizeSize, fallback.output.optimizeSize),
      linearize: booleanOr(output.linearize, fallback.output.linearize),
    },
  };
}

function parseStored(json: string | null | undefined): Settings {
  if (!json) return parseSettings(null);
  try {
    return parseSettings(JSON.parse(json));
  } catch {
    return parseSettings(null);
  }
}

function sameSettings(a: Settings, b: Settings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- Environment -------------------------------------------------------------------------------

interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
}

interface ElementLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

export interface SettingsDocument {
  documentElement: { lang: string; setAttribute(name: string, value: string): void };
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
}

/** Everything this module needs from the browser; replaced by fakes in tests. */
export interface SettingsEnvironment {
  /** `null`/absent when storage is unavailable (private mode, blocked cookies). */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null | undefined;
  /** Receives `storage` and `languagechange` (the window). */
  events?: Pick<EventTarget, 'addEventListener'> | undefined;
  matchMedia?: ((query: string) => MediaQueryLike) | undefined;
  /** `navigator.languages`, read again whenever the browser reports a change. */
  languages?: (() => readonly string[]) | undefined;
  document?: SettingsDocument | undefined;
}

export interface SettingsStore {
  readonly settings: ReadonlySignal<Settings>;
  /** The theme in effect: the setting, with `system` resolved through the OS preference. */
  readonly theme: ReadonlySignal<ResolvedTheme>;
  /** The locale in effect: the setting, with `auto` resolved through the browser languages. */
  readonly locale: ReadonlySignal<Locale>;
  /** The output settings in the engine's vocabulary. */
  readonly outputOptions: ReadonlySignal<Pick<OutputOptions, 'streams' | 'linearize'>>;
  /** Changes some settings and stores the result. Invalid values are ignored. */
  update(patch: SettingsPatch): void;
  reset(): void;
  /**
   * Keeps `<html data-theme>`, `<html lang>` and the `theme-color` metas in step with the
   * settings from now on. Returns a function that stops doing so.
   */
  applyEffects(): () => void;
}

export function createSettingsStore(env: SettingsEnvironment = {}): SettingsStore {
  function read(): Settings {
    try {
      return parseStored(env.storage?.getItem(SETTINGS_KEY));
    } catch {
      return parseSettings(null);
    }
  }

  function write(value: Settings): void {
    try {
      env.storage?.setItem(SETTINGS_KEY, JSON.stringify(value));
    } catch {
      // Storage full or blocked: the setting still applies until the page is closed.
    }
  }

  function readLanguages(): readonly string[] {
    try {
      return env.languages?.() ?? [];
    } catch {
      return [];
    }
  }

  let darkQuery: MediaQueryLike | undefined;
  try {
    darkQuery = env.matchMedia?.(DARK_QUERY);
  } catch {
    darkQuery = undefined;
  }

  const state = signal<Settings>(read());
  const systemDark = signal(darkQuery?.matches === true);
  const languages = signal<readonly string[]>(readLanguages());

  darkQuery?.addEventListener?.('change', () => {
    systemDark.value = darkQuery.matches;
  });
  env.events?.addEventListener('languagechange', () => {
    languages.value = readLanguages();
  });
  // Fired in every *other* tab of the app when one tab writes.
  env.events?.addEventListener('storage', (event) => {
    const { key, newValue } = event as StorageEvent;
    // `key === null`: the whole storage was cleared.
    if (key !== null && key !== SETTINGS_KEY) return;
    const next = parseStored(key === null ? null : newValue);
    if (!sameSettings(next, state.peek())) state.value = next;
  });

  const theme = computed<ResolvedTheme>(() => {
    const setting = state.value.theme;
    return setting === 'system' ? (systemDark.value ? 'dark' : 'light') : setting;
  });
  const locale = computed<Locale>(() => resolveLocale(state.value.language, languages.value));
  const outputOptions = computed(() => ({
    streams: state.value.output.optimizeSize ? ('compress' as const) : ('preserve' as const),
    linearize: state.value.output.linearize,
  }));

  function commit(next: Settings): void {
    if (sameSettings(next, state.peek())) return;
    state.value = next;
    write(next);
  }

  return {
    settings: state,
    theme,
    locale,
    outputOptions,
    update(patch) {
      const current = state.peek();
      commit(
        parseSettings(
          {
            ...current,
            ...patch,
            naming: { ...current.naming, ...patch.naming },
            output: { ...current.output, ...patch.output },
          },
          current,
        ),
      );
    },
    reset() {
      commit(parseSettings(null));
    },
    applyEffects() {
      const doc = env.document;
      if (!doc) return () => undefined;
      return effect(() => {
        const setting = state.value.theme;
        const resolved = theme.value;
        doc.documentElement.setAttribute('data-theme', resolved);
        doc.documentElement.lang = locale.value;
        // index.html carries one meta per colour scheme. Following the system, each keeps its
        // own colour; with a fixed theme both show that theme's colour.
        const metas = doc.querySelectorAll(THEME_COLOR_SELECTOR);
        for (let i = 0; i < metas.length; i++) {
          const meta = metas[i]!;
          const media = meta.getAttribute('media');
          const own: ResolvedTheme =
            media === null ? resolved : media.includes('dark') ? 'dark' : 'light';
          meta.setAttribute('content', THEME_COLORS[setting === 'system' ? own : setting]);
        }
      });
    },
  };
}

function browserEnvironment(): SettingsEnvironment {
  if (typeof window === 'undefined') return {};
  let storage: Storage | null = null;
  try {
    // The getter itself throws where storage is blocked.
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return {
    storage,
    events: window,
    matchMedia: typeof window.matchMedia === 'function' ? (q) => window.matchMedia(q) : undefined,
    languages: () => navigator.languages ?? [navigator.language],
    document: typeof document === 'undefined' ? undefined : document,
  };
}

/** The app's settings. Created on import so that the first render already has them. */
export const settingsStore = createSettingsStore(browserEnvironment());

export const settings: ReadonlySignal<Settings> = settingsStore.settings;
export const resolvedTheme: ReadonlySignal<ResolvedTheme> = settingsStore.theme;
export const locale: ReadonlySignal<Locale> = settingsStore.locale;

export function updateSettings(patch: SettingsPatch): void {
  settingsStore.update(patch);
}

export function resetSettings(): void {
  settingsStore.reset();
}
