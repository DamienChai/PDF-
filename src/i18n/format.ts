/**
 * Locale-aware formatting of the quantities the app shows. Like `t()`, every function reads the
 * locale signal and is therefore reactive when called while rendering.
 */
import { formatBytes } from '../lib/filename';
import { locale } from '../state/settings';
import { formatNumberFor, t } from './translate';

/** `1536` → `1.5 KB`. */
export function formatSize(bytes: number): string {
  return formatBytes(bytes, locale.value);
}

export function formatNumber(value: number): string {
  return formatNumberFor(locale.value, value);
}

/**
 * A fraction in [0, 1] as a whole percentage. Rounds down, so that a progress display only
 * reaches 100% when the work is finished.
 */
export function formatPercent(fraction: number): string {
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return `${formatNumber(Math.floor(clamped * 100 + 1e-9))}%`;
}

/** `4` → `4 页` / `4 pages`. */
export function formatPages(count: number): string {
  return t('format.pages', { count });
}

/** `3` → `3 个文件` / `3 files`. */
export function formatFiles(count: number): string {
  return t('format.files', { count });
}

/** A processing time: `不到 1 秒`, `2.4 秒`, `38 秒`, `1 分 5 秒`. */
export function formatDuration(milliseconds: number): string {
  const ms = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  if (ms < 950) return t('format.lessThanSecond');
  const seconds = ms / 1000;
  if (seconds < 9.95) {
    const value = new Intl.NumberFormat(locale.value, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(seconds);
    return t('format.seconds', { value });
  }
  const whole = Math.round(seconds);
  if (whole < 60) return t('format.seconds', { value: whole });
  return t('format.minutes', { minutes: Math.floor(whole / 60), seconds: whole % 60 });
}

/** Joins already translated parts with the language's list separator (`、` / `, `). */
export function formatList(parts: readonly string[]): string {
  return parts.join(t('list.separator'));
}
