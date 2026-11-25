/** Supported locales and how one is chosen. Pure: no signals, no browser access. */

export const LOCALES = ['zh-CN', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

/** The language setting: follow the system, or a fixed locale. */
export type LanguageSetting = 'auto' | Locale;

export const FALLBACK_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en';
}

function primarySubtag(tag: string): string {
  return tag.toLowerCase().split(/[-_]/, 1)[0] ?? '';
}

/**
 * Picks the locale for a preference list such as `navigator.languages`: the first entry that is
 * Chinese (any script or region) or English wins; everything else falls back to English.
 *
 * public/boot.js repeats this rule for the pre-paint `<html lang>`; a unit test keeps them equal.
 */
export function detectLocale(languages: readonly string[] | null | undefined): Locale {
  for (const tag of languages ?? []) {
    const primary = primarySubtag(String(tag));
    if (primary === 'zh') return 'zh-CN';
    if (primary === 'en') return 'en';
  }
  return FALLBACK_LOCALE;
}

export function resolveLocale(
  setting: LanguageSetting,
  languages: readonly string[] | null | undefined,
): Locale {
  return setting === 'auto' ? detectLocale(languages) : setting;
}
