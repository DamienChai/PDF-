/** Secure random passwords. */

export interface GenerateOptions {
  /** Number of characters. Default 20. */
  length?: number;
  /** Include punctuation. Default true. */
  symbols?: boolean;
  /** Leave out look-alike characters (0/O, 1/l/I …). Default true. */
  avoidAmbiguous?: boolean;
}

export const DEFAULT_PASSWORD_LENGTH = 20;
/** AES-256 passwords are limited to 127 bytes; every character produced here is one byte. */
export const MAX_PASSWORD_LENGTH = 127;

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
/** Every printable ASCII punctuation character (no space: easy to lose at either end). */
const SYMBOLS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
/** Punctuation that is easy to tell apart, to read out and to find on a phone keyboard. */
const CLEAR_SYMBOLS = '!#$%&*+-=?@^_';
/** Characters that are easily mistaken for one another in common fonts. */
const AMBIGUOUS = new Set('0Oo1lI|');

/** Source of randomness; replaceable in tests. Must fill the array with uniform random values. */
export type RandomSource = (array: Uint32Array<ArrayBuffer>) => void;

const systemRandom: RandomSource = (array) => {
  crypto.getRandomValues(array);
};

/**
 * Uniform random integers in `[0, bound)` from a source of random 32-bit words.
 *
 * `value % bound` would favour small results whenever 2³² is not a multiple of `bound`; values
 * from the incomplete last range are therefore rejected and drawn again.
 */
export function createUniformPicker(
  random: RandomSource = systemRandom,
): (bound: number) => number {
  const pool = new Uint32Array(64);
  let next = pool.length;
  return (bound) => {
    if (!Number.isInteger(bound) || bound < 1 || bound > 0x1_0000_0000) {
      throw new RangeError('bound must be an integer between 1 and 2^32');
    }
    const limit = 0x1_0000_0000 - (0x1_0000_0000 % bound);
    for (;;) {
      if (next === pool.length) {
        random(pool);
        next = 0;
      }
      const value = pool[next]!;
      // Used words are wiped so that no password material lingers in the buffer.
      pool[next++] = 0;
      if (value < limit) return value % bound;
    }
  };
}

function characterClasses(symbols: boolean, avoidAmbiguous: boolean): string[] {
  const classes = [LOWER, UPPER, DIGITS];
  if (symbols) classes.push(avoidAmbiguous ? CLEAR_SYMBOLS : SYMBOLS);
  if (!avoidAmbiguous) return classes;
  return classes.map((chars) => [...chars].filter((char) => !AMBIGUOUS.has(char)).join(''));
}

/**
 * Generates a password with `crypto.getRandomValues` (unbiased), ASCII only so it works with
 * every PDF encryption algorithm, containing at least one character of each enabled class.
 *
 * `length` is clamped to the number of enabled classes … 127.
 */
export function generatePassword(options: GenerateOptions = {}, random?: RandomSource): string {
  const classes = characterClasses(options.symbols ?? true, options.avoidAmbiguous ?? true);
  const alphabet = classes.join('');
  const requested = Number(options.length ?? DEFAULT_PASSWORD_LENGTH);
  const length = Math.min(
    MAX_PASSWORD_LENGTH,
    Math.max(
      classes.length,
      Number.isNaN(requested) ? DEFAULT_PASSWORD_LENGTH : Math.trunc(requested),
    ),
  );
  const pick = createUniformPicker(random);

  // Draw whole candidates until one contains every class. Unlike "place one character of each
  // class, fill up, shuffle", this keeps the result uniformly distributed over all passwords that
  // satisfy the rule. A 20-character candidate is accepted about nine times out of ten.
  for (;;) {
    let candidate = '';
    for (let i = 0; i < length; i++) candidate += alphabet[pick(alphabet.length)];
    if (classes.every((chars) => containsAny(candidate, chars))) return candidate;
  }
}

function containsAny(text: string, chars: string): boolean {
  for (const char of text) if (chars.includes(char)) return true;
  return false;
}
