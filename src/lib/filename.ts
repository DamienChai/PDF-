/** File-name helpers: safe names for every platform, output naming, de-duplication, sizes. */

export type NameOperation = 'decrypt' | 'encrypt';

export interface NamingOptions {
  /** Appended to the base name of decrypted files, e.g. `report_unlocked.pdf`. May be ''. */
  decryptSuffix: string;
  /** Appended to the base name of encrypted files, e.g. `report_locked.pdf`. May be ''. */
  encryptSuffix: string;
}

export const DEFAULT_NAMING: Readonly<NamingOptions> = Object.freeze({
  decryptSuffix: '_unlocked',
  encryptSuffix: '_locked',
});

/** Used when nothing usable is left of a name. */
const FALLBACK_BASE = 'document';

/**
 * Longest name we produce, in UTF-8 bytes. ext4/f2fs (Android, Linux) allow 255 bytes per name,
 * NTFS and APFS 255 UTF-16 units; the margin leaves room for what browsers and download managers
 * append themselves (" (1)", ".crdownload").
 */
export const MAX_NAME_BYTES = 240;

/** A dot followed by a few letters or digits; anything else is part of the base name. */
const EXTENSION = /^\.[\p{L}\p{N}]{1,16}$/u;

// C0/C1 controls, zero-width and BOM characters, and the bidirectional embedding/override/isolate
// controls that can be abused to disguise an extension ("invoice‮fdp.exe").
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F​⁠﻿‪-‮⁦-⁩]/g;
// Not allowed in Windows file names; `/` is the path separator everywhere else.
const ILLEGAL = /[<>:"/\\|?*]/g;
// Lone surrogates cannot be encoded as UTF-8 and break downloads on some platforms.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// Windows device names are reserved with any extension ("NUL.pdf", "com1.tar.gz").
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (text.length * 3 <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = utf8Length(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/** Windows silently drops trailing dots and spaces, which would change the name behind our back. */
function trimEnd(text: string): string {
  return text.replace(/[. ]+$/u, '');
}

/** Splits `name` into base and extension (extension includes the dot, or is ''). */
export function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' };
  const ext = name.slice(dot);
  return EXTENSION.test(ext) ? { base: name.slice(0, dot), ext } : { base: name, ext: '' };
}

/** Replaces everything that is unsafe on at least one platform; may return ''. */
function cleanCharacters(name: string): string {
  return name
    .normalize('NFC')
    .replace(LONE_SURROGATE, '')
    .replace(/[\t\n\r]+/g, ' ')
    .replace(INVISIBLE, '')
    .replace(ILLEGAL, '_')
    .replace(/\s+/gu, ' ');
}

function escapeReserved(name: string): string {
  const stem = name.split('.', 1)[0] ?? '';
  return RESERVED.test(stem.trim()) ? `_${name}` : name;
}

/**
 * Joins a base name and a fixed tail (suffix + extension) so that the result fits into
 * `MAX_NAME_BYTES`, shortening only the base.
 */
function fit(base: string, tail: string): string {
  // One byte is kept in reserve for the underscore that defuses a reserved device name.
  const limit = MAX_NAME_BYTES - 1;
  let room = limit - utf8Length(tail);
  if (room < 8) {
    // Absurdly long tail: shorten it in front of its extension so the base keeps a little room.
    const { base: tailBase, ext } = splitExtension(tail);
    tail = truncateUtf8(tailBase, Math.max(0, limit - utf8Length(ext) - 8)) + ext;
    room = limit - utf8Length(tail);
  }
  let shortened = truncateUtf8(base, room);
  // With a tail the end of the name is protected already; without one, Windows would strip it.
  shortened = tail === '' ? trimEnd(shortened) : shortened.replace(/ +$/u, '');
  if (shortened === '') shortened = FALLBACK_BASE;
  return escapeReserved(shortened + tail);
}

/** Removes characters that are illegal in file names on Windows/macOS/Android; never returns ''. */
export function sanitizeFileName(name: string): string {
  const cleaned = trimEnd(cleanCharacters(String(name)).trim());
  // A bare extension (".pdf") keeps its meaning and gets a base name.
  const bareExtension = cleaned.replace(/^\.+/u, '.');
  if (EXTENSION.test(bareExtension)) return fit('', bareExtension);
  // Leading dots would hide the file on Android, macOS and Linux.
  const visible = cleaned.replace(/^[. ]+/u, '');
  const { base, ext } = splitExtension(visible);
  return fit(trimEnd(base), ext);
}

function stripSuffix(base: string, suffix: string): string {
  if (suffix === '' || base.length <= suffix.length) return base;
  return base.toLowerCase().endsWith(suffix.toLowerCase()) ? base.slice(0, -suffix.length) : base;
}

/** `report.pdf` + decrypt → `report_unlocked.pdf`. Always ends in `.pdf`. */
export function outputFileName(
  inputName: string,
  operation: NameOperation,
  naming: NamingOptions = DEFAULT_NAMING,
): string {
  const decryptSuffix = trimEnd(cleanCharacters(naming.decryptSuffix));
  const encryptSuffix = trimEnd(cleanCharacters(naming.encryptSuffix));
  const [suffix, opposite] =
    operation === 'decrypt' ? [decryptSuffix, encryptSuffix] : [encryptSuffix, decryptSuffix];

  let base = cleanCharacters(String(inputName)).trim();
  base = trimEnd(trimEnd(base).replace(/\.pdf$/i, '')).replace(/^[. ]+/u, '');
  // Re-processing one of our own outputs should swap the suffix instead of stacking them:
  // `report_locked.pdf` + decrypt → `report_unlocked.pdf`, and never `…_unlocked_unlocked.pdf`.
  base = stripSuffix(stripSuffix(base, suffix), opposite);
  base = trimEnd(base);

  return fit(base, `${suffix}.pdf`);
}

/** Comparison key: file systems on Windows and macOS are case- and normalisation-insensitive. */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

function withCounter(name: string, counter: number): string {
  const { base, ext } = splitExtension(name);
  return fit(base, ` (${counter})${ext}`);
}

/**
 * Makes a list of names unique, case-insensitively, by appending ` (2)`, ` (3)` … before the
 * extension.
 */
export function uniqueNames(names: readonly string[]): string[] {
  // The first occurrence of every name keeps it, so already-unique lists come back unchanged even
  // when a later duplicate would otherwise have claimed e.g. `a (2).pdf` first.
  const taken = new Set<string>();
  const firstIndex = new Map<string, number>();
  names.forEach((name, index) => {
    const key = nameKey(name);
    if (!firstIndex.has(key)) {
      firstIndex.set(key, index);
      taken.add(key);
    }
  });

  const nextCounter = new Map<string, number>();
  return names.map((name, index) => {
    const key = nameKey(name);
    if (firstIndex.get(key) === index) return name;
    let counter = nextCounter.get(key) ?? 2;
    let candidate = withCounter(name, counter);
    while (taken.has(nameKey(candidate))) candidate = withCounter(name, ++counter);
    nextCounter.set(key, counter + 1);
    taken.add(nameKey(candidate));
    return candidate;
  });
}

/**
 * Returns `name`, or the first ` (2)`, ` (3)` … variant for which `isTaken` reports false.
 * Used when writing next to files that already exist on disk.
 */
export async function firstFreeName(
  name: string,
  isTaken: (candidate: string) => boolean | Promise<boolean>,
): Promise<string> {
  let candidate = name;
  for (let counter = 2; await isTaken(candidate); counter++) candidate = withCounter(name, counter);
  return candidate;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** `1536` → `1.5 KB` (binary units, locale-aware decimal separator). */
export function formatBytes(bytes: number, locale?: string): string {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  let digits = fractionDigits(value, unit);
  // 1023.97 KB would round to "1,024 KB": show "1 MB" instead.
  if (Number(value.toFixed(digits)) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
    digits = fractionDigits(value, unit);
  }
  return `${numberFormat(locale, digits).format(value)} ${UNITS[unit]}`;
}

// Constructing an Intl.NumberFormat is slow compared to using one, and sizes are formatted for
// every row of a file list.
const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string | undefined, digits: number): Intl.NumberFormat {
  const key = `${locale ?? ''}/${digits}`;
  let format = numberFormats.get(key);
  if (!format) {
    const options = { maximumFractionDigits: digits, useGrouping: false };
    try {
      format = new Intl.NumberFormat(locale, options);
    } catch {
      // Not a valid language tag ("zh_CN"): better the default locale than a crashed view.
      format = new Intl.NumberFormat(undefined, options);
    }
    numberFormats.set(key, format);
  }
  return format;
}

/** Three significant digits, and never a fraction of a byte. */
function fractionDigits(value: number, unit: number): number {
  if (unit === 0 || value >= 100) return 0;
  return value >= 10 ? 1 : 2;
}
