/** Secure random passwords. CONTRACT STUB — implemented by the platform workstream. */

export interface GenerateOptions {
  /** Number of characters. Default 20. */
  length?: number;
  /** Include punctuation. Default true. */
  symbols?: boolean;
  /** Leave out look-alike characters (0/O, 1/l/I …). Default true. */
  avoidAmbiguous?: boolean;
}

/**
 * Generates a password with `crypto.getRandomValues` (unbiased), ASCII only so it works with
 * every PDF encryption algorithm, containing at least one character of each enabled class.
 */
export function generatePassword(_options?: GenerateOptions): string {
  throw new Error('not implemented');
}
