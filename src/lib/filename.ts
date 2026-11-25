/** File-name helpers. CONTRACT STUB — bodies are implemented by the platform workstream. */

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

/** Removes characters that are illegal in file names on Windows/macOS/Android; never returns ''. */
export function sanitizeFileName(_name: string): string {
  throw new Error('not implemented');
}

/** `report.pdf` + decrypt → `report_unlocked.pdf`. Always ends in `.pdf`. */
export function outputFileName(
  _inputName: string,
  _operation: NameOperation,
  _naming?: NamingOptions,
): string {
  throw new Error('not implemented');
}

/** Makes a list of names unique, case-insensitively, by appending ` (2)`, ` (3)` … before the extension. */
export function uniqueNames(_names: readonly string[]): string[] {
  throw new Error('not implemented');
}

/** `1536` → `1.5 KB` (binary units, locale-aware decimal separator). */
export function formatBytes(_bytes: number, _locale?: string): string {
  throw new Error('not implemented');
}
