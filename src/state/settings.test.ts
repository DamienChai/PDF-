import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMING } from '../lib/filename';
import {
  DEFAULT_SETTINGS,
  MAX_SUFFIX_LENGTH,
  SETTINGS_KEY,
  THEME_COLORS,
  createSettingsStore,
  normalizeSuffix,
  parseSettings,
  type Settings,
  type SettingsEnvironment,
} from './settings';

class MemoryStorage {
  readonly data = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes++;
    this.data.set(key, value);
  }
}

class FakeMediaQuery extends EventTarget {
  matches = false;
  set(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(new Event('change'));
  }
}

class FakeMeta {
  constructor(
    readonly media: string | null,
    public content: string,
  ) {}
  getAttribute(name: string): string | null {
    return name === 'media' ? this.media : name === 'content' ? this.content : null;
  }
  setAttribute(name: string, value: string): void {
    if (name === 'content') this.content = value;
  }
}

/** The parts of index.html that boot.js and the settings module touch. */
function fakeDocument() {
  const attributes = new Map<string, string>();
  const metas = [
    new FakeMeta('(prefers-color-scheme: light)', THEME_COLORS.light),
    new FakeMeta('(prefers-color-scheme: dark)', THEME_COLORS.dark),
  ];
  return {
    attributes,
    metas,
    documentElement: {
      lang: 'en',
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
    },
    querySelectorAll: (selector: string) => (selector === 'meta[name="theme-color"]' ? metas : []),
  };
}

function snapshot(doc: ReturnType<typeof fakeDocument>) {
  return {
    theme: doc.attributes.get('data-theme'),
    lang: doc.documentElement.lang,
    colors: doc.metas.map((meta) => meta.content),
  };
}

interface SetupOptions {
  stored?: string;
  dark?: boolean;
  languages?: string[];
  storage?: SettingsEnvironment['storage'];
}

function setup(options: SetupOptions = {}) {
  const storage = new MemoryStorage();
  if (options.stored !== undefined) storage.data.set(SETTINGS_KEY, options.stored);
  const events = new EventTarget();
  const media = new FakeMediaQuery();
  media.matches = options.dark ?? false;
  const languages = { current: options.languages ?? ['en-US'] };
  const doc = fakeDocument();
  const store = createSettingsStore({
    storage: 'storage' in options ? options.storage : storage,
    events,
    matchMedia: () => media,
    languages: () => languages.current,
    document: doc,
  });
  const emitStorage = (key: string | null, newValue: string | null): void => {
    const event = new Event('storage') as Event & { key: string | null; newValue: string | null };
    event.key = key;
    event.newValue = newValue;
    events.dispatchEvent(event);
  };
  return { store, storage, events, media, languages, doc, emitStorage };
}

describe('parseSettings', () => {
  it('returns the defaults for anything that is not an object', () => {
    for (const raw of [null, undefined, 42, 'text', true, [], [1, 2]]) {
      expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('keeps valid fields and replaces invalid ones one by one', () => {
    const parsed = parseSettings({
      theme: 'dark',
      language: 'fr',
      naming: { decryptSuffix: '-open', encryptSuffix: 7 },
      autoSave: 'yes',
      output: { optimizeSize: true, linearize: null },
      unknown: 'dropped',
    });
    expect(parsed).toEqual({
      theme: 'dark',
      language: 'auto',
      naming: { decryptSuffix: '-open', encryptSuffix: DEFAULT_NAMING.encryptSuffix },
      autoSave: false,
      output: { optimizeSize: true, linearize: false },
    });
    expect(parsed).not.toHaveProperty('unknown');
  });

  it('tolerates sections of the wrong type', () => {
    expect(parseSettings({ naming: 'x', output: [true] })).toEqual(DEFAULT_SETTINGS);
  });

  it('accepts empty suffixes and rejects absurdly long ones', () => {
    const parsed = parseSettings({
      naming: { decryptSuffix: '', encryptSuffix: 'x'.repeat(MAX_SUFFIX_LENGTH + 1) },
    });
    expect(parsed.naming).toEqual({
      decryptSuffix: '',
      encryptSuffix: DEFAULT_NAMING.encryptSuffix,
    });
  });

  it('removes characters that cannot be part of a file name from suffixes', () => {
    expect(normalizeSuffix('_un/lo:ck*ed\u0000')).toBe('_unlocked');
    expect(normalizeSuffix(' (已解锁)')).toBe(' (已解锁)');
    expect(normalizeSuffix('x'.repeat(100))).toHaveLength(MAX_SUFFIX_LENGTH);
    expect(parseSettings({ naming: { decryptSuffix: 'a|b' } }).naming.decryptSuffix).toBe('ab');
  });

  it('falls back to the given settings instead of the defaults', () => {
    const current: Settings = { ...DEFAULT_SETTINGS, theme: 'light', autoSave: true };
    expect(parseSettings({ theme: 'neon', autoSave: 1 }, current)).toEqual(current);
  });
});

describe('settings store: loading', () => {
  it('starts with the defaults when nothing is stored', () => {
    const { store, storage } = setup();
    expect(store.settings.value).toEqual(DEFAULT_SETTINGS);
    expect(storage.writes).toBe(0);
  });

  it('reads what an earlier session stored', () => {
    const stored: Settings = {
      theme: 'dark',
      language: 'zh-CN',
      naming: { decryptSuffix: '-open', encryptSuffix: '-safe' },
      autoSave: true,
      output: { optimizeSize: true, linearize: true },
    };
    const { store } = setup({ stored: JSON.stringify(stored) });
    expect(store.settings.value).toEqual(stored);
  });

  it.each(['{not json', '', 'null', '"text"', '[]', '12'])(
    'falls back to the defaults for the stored value %j',
    (stored) => {
      expect(setup({ stored }).store.settings.value).toEqual(DEFAULT_SETTINGS);
    },
  );

  it('repairs a partly valid stored object field by field', () => {
    const { store } = setup({ stored: JSON.stringify({ theme: 'light', language: 12 }) });
    expect(store.settings.value).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' });
  });

  it('works without any storage', () => {
    const { store } = setup({ storage: null });
    store.update({ theme: 'dark' });
    expect(store.settings.value.theme).toBe('dark');
  });

  it('works when storage throws on every access', () => {
    const broken = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    };
    const { store } = setup({ storage: broken });
    expect(store.settings.value).toEqual(DEFAULT_SETTINGS);
    expect(() => store.update({ autoSave: true })).not.toThrow();
    expect(store.settings.value.autoSave).toBe(true);
  });

  it('works without any browser environment at all', () => {
    const store = createSettingsStore();
    expect(store.settings.value).toEqual(DEFAULT_SETTINGS);
    expect(store.theme.value).toBe('light');
    expect(store.locale.value).toBe('en');
    expect(() => store.applyEffects()()).not.toThrow();
  });
});

describe('settings store: changing', () => {
  it('stores every change', () => {
    const { store, storage } = setup();
    store.update({ theme: 'dark', naming: { decryptSuffix: '-open' } });
    expect(store.settings.value.theme).toBe('dark');
    expect(store.settings.value.naming).toEqual({
      decryptSuffix: '-open',
      encryptSuffix: DEFAULT_NAMING.encryptSuffix,
    });
    expect(JSON.parse(storage.data.get(SETTINGS_KEY)!)).toEqual(store.settings.value);
  });

  it('merges nested sections instead of replacing them', () => {
    const { store } = setup();
    store.update({ output: { optimizeSize: true } });
    store.update({ output: { linearize: true } });
    expect(store.settings.value.output).toEqual({ optimizeSize: true, linearize: true });
  });

  it('ignores invalid values and keeps the current ones', () => {
    const { store } = setup();
    store.update({ theme: 'dark' });
    store.update({ theme: 'neon' as never, autoSave: 'yes' as never });
    expect(store.settings.value.theme).toBe('dark');
    expect(store.settings.value.autoSave).toBe(false);
  });

  it('does not write or notify when nothing changes', () => {
    const { store, storage } = setup();
    let notifications = -1;
    store.settings.subscribe(() => notifications++);
    store.update({ theme: 'system' });
    expect(storage.writes).toBe(0);
    expect(notifications).toBe(0);
  });

  it('resets to the defaults', () => {
    const { store, storage } = setup();
    store.update({ theme: 'dark', autoSave: true });
    store.reset();
    expect(store.settings.value).toEqual(DEFAULT_SETTINGS);
    expect(JSON.parse(storage.data.get(SETTINGS_KEY)!)).toEqual(DEFAULT_SETTINGS);
  });

  it('maps the output settings to engine options', () => {
    const { store } = setup();
    expect(store.outputOptions.value).toEqual({ streams: 'preserve', linearize: false });
    store.update({ output: { optimizeSize: true, linearize: true } });
    expect(store.outputOptions.value).toEqual({ streams: 'compress', linearize: true });
  });
});

describe('settings store: other tabs', () => {
  it('adopts what another tab stored, without writing it back', () => {
    const { store, storage, emitStorage } = setup();
    emitStorage(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, theme: 'dark' }));
    expect(store.settings.value.theme).toBe('dark');
    expect(storage.writes).toBe(0);
  });

  it('ignores other keys', () => {
    const { store, emitStorage } = setup();
    emitStorage('pdfkey:offline-ready', '1');
    emitStorage('something', JSON.stringify({ theme: 'dark' }));
    expect(store.settings.value).toEqual(DEFAULT_SETTINGS);
  });

  it('returns to the defaults when the storage is cleared or the entry removed', () => {
    const { store, emitStorage } = setup({ stored: JSON.stringify({ theme: 'dark' }) });
    emitStorage(null, null);
    expect(store.settings.value).toEqual(DEFAULT_SETTINGS);
    store.update({ theme: 'light' });
    emitStorage(SETTINGS_KEY, null);
    expect(store.settings.value).toEqual(DEFAULT_SETTINGS);
  });

  it('validates what another tab stored', () => {
    const { store, emitStorage } = setup();
    emitStorage(SETTINGS_KEY, '{broken');
    expect(store.settings.value).toEqual(DEFAULT_SETTINGS);
    emitStorage(SETTINGS_KEY, JSON.stringify({ theme: 'dark', language: 'xx' }));
    expect(store.settings.value).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' });
  });
});

describe('settings store: theme and language', () => {
  it('resolves the system theme and follows the OS', () => {
    const { store, media } = setup({ dark: true });
    expect(store.theme.value).toBe('dark');
    media.set(false);
    expect(store.theme.value).toBe('light');
  });

  it('lets a fixed theme win over the OS', () => {
    const { store, media } = setup({ dark: true });
    store.update({ theme: 'light' });
    expect(store.theme.value).toBe('light');
    media.set(false);
    media.set(true);
    expect(store.theme.value).toBe('light');
  });

  it('detects the language and follows the browser', () => {
    const { store, languages, events } = setup({ languages: ['zh-TW', 'en'] });
    expect(store.locale.value).toBe('zh-CN');
    languages.current = ['de-DE', 'en-GB'];
    events.dispatchEvent(new Event('languagechange'));
    expect(store.locale.value).toBe('en');
  });

  it('lets a fixed language win over the browser', () => {
    const { store } = setup({ languages: ['zh-CN'] });
    store.update({ language: 'en' });
    expect(store.locale.value).toBe('en');
    store.update({ language: 'auto' });
    expect(store.locale.value).toBe('zh-CN');
  });
});

describe('settings store: document side effects', () => {
  it('applies theme, language and browser UI colours, and keeps them up to date', () => {
    const { store, doc, media } = setup({ dark: true, languages: ['zh-CN'] });
    const dispose = store.applyEffects();
    expect(snapshot(doc)).toEqual({
      theme: 'dark',
      lang: 'zh-CN',
      colors: [THEME_COLORS.light, THEME_COLORS.dark],
    });

    store.update({ theme: 'light', language: 'en' });
    expect(snapshot(doc)).toEqual({
      theme: 'light',
      lang: 'en',
      colors: [THEME_COLORS.light, THEME_COLORS.light],
    });

    store.update({ theme: 'dark' });
    expect(snapshot(doc).colors).toEqual([THEME_COLORS.dark, THEME_COLORS.dark]);

    store.update({ theme: 'system' });
    media.set(false);
    expect(snapshot(doc)).toEqual({
      theme: 'light',
      lang: 'en',
      colors: [THEME_COLORS.light, THEME_COLORS.dark],
    });

    dispose();
    store.update({ theme: 'dark' });
    expect(snapshot(doc).theme).toBe('light');
  });

  it('gives a theme-color meta without a media query the colour of the theme in effect', () => {
    const { store, doc, media } = setup();
    const plain = new FakeMeta(null, '');
    doc.metas.push(plain);
    store.applyEffects();
    expect(plain.content).toBe(THEME_COLORS.light);
    media.set(true);
    expect(plain.content).toBe(THEME_COLORS.dark);
  });
});

describe('public/boot.js', () => {
  const source = readFileSync(new URL('../../public/boot.js', import.meta.url), 'utf8');

  function runBoot(options: {
    stored: string | null | Error;
    dark: boolean;
    languages: string[];
  }): ReturnType<typeof snapshot> {
    const doc = fakeDocument();
    const localStorage = {
      getItem: () => {
        if (options.stored instanceof Error) throw options.stored;
        return options.stored;
      },
    };
    const matchMedia = () => ({ matches: options.dark });
    const navigator = { languages: options.languages };
    new Function('localStorage', 'matchMedia', 'document', 'navigator', source)(
      localStorage,
      matchMedia,
      doc,
      navigator,
    );
    return snapshot(doc);
  }

  const storedValues: Array<string | null | Error> = [
    null,
    '',
    '{broken',
    'null',
    '7',
    '"text"',
    '[]',
    JSON.stringify({ theme: 'neon', language: 'fr' }),
    new Error('storage is blocked'),
    ...(['system', 'light', 'dark'] as const).flatMap((theme) =>
      (['auto', 'zh-CN', 'en'] as const).map((language) =>
        JSON.stringify({ ...DEFAULT_SETTINGS, theme, language }),
      ),
    ),
  ];
  const languageLists = [
    ['zh-CN'],
    ['zh-Hant-TW', 'en'],
    ['en-US', 'zh-CN'],
    ['fr', 'zh'],
    ['de'],
    [],
  ];

  it('leaves the document exactly as the settings module does', () => {
    let cases = 0;
    for (const stored of storedValues) {
      for (const dark of [false, true]) {
        for (const languages of languageLists) {
          const fromBoot = runBoot({ stored, dark, languages });
          const { store, doc } = setup({
            ...(typeof stored === 'string' ? { stored } : {}),
            dark,
            languages,
          });
          store.applyEffects();
          expect(fromBoot, JSON.stringify({ stored: String(stored), dark, languages })).toEqual(
            snapshot(doc),
          );
          cases++;
        }
      }
    }
    expect(cases).toBe(storedValues.length * 2 * languageLists.length);
  });

  it('survives a browser without matchMedia or navigator.languages', () => {
    const doc = fakeDocument();
    const run = new Function('localStorage', 'matchMedia', 'document', 'navigator', source);
    run({ getItem: () => null }, undefined, doc, { language: 'zh-CN' });
    expect(snapshot(doc)).toMatchObject({ theme: 'light', lang: 'zh-CN' });
  });

  it('is small and sticks to ES5 syntax', () => {
    expect(source.length).toBeLessThan(4096);
    const code = source
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");
    expect(code).not.toMatch(/=>|`|\.\.\.|\?\?|\?\./);
    expect(code).not.toMatch(/\b(?:let|const|class|async|await|import|export|of)\b/);
  });
});
