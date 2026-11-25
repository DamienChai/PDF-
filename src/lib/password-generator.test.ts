import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  createUniformPicker,
  generatePassword,
  type RandomSource,
} from './password-generator';

const AMBIGUOUS = /[0Oo1lI|]/;
const HAS_LOWER = /[a-z]/;
const HAS_UPPER = /[A-Z]/;
const HAS_DIGIT = /[0-9]/;
const HAS_SYMBOL = /[^A-Za-z0-9]/;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/** A source that replays the given 32-bit words, then fails. */
function scripted(words: number[]): RandomSource & { used: () => number } {
  let position = 0;
  const source = ((array: Uint32Array) => {
    for (let i = 0; i < array.length; i++) {
      if (position >= words.length) throw new Error('script exhausted');
      array[i] = words[position++]!;
    }
  }) as RandomSource & { used: () => number };
  source.used = () => position;
  return source;
}

describe('generatePassword', () => {
  it('defaults to 20 characters with all four classes and no look-alikes', () => {
    for (let i = 0; i < 2000; i++) {
      const password = generatePassword();
      expect(password).toHaveLength(DEFAULT_PASSWORD_LENGTH);
      expect(password).toMatch(PRINTABLE_ASCII);
      expect(password).toMatch(HAS_LOWER);
      expect(password).toMatch(HAS_UPPER);
      expect(password).toMatch(HAS_DIGIT);
      expect(password).toMatch(HAS_SYMBOL);
      expect(password).not.toMatch(AMBIGUOUS);
    }
  });

  it('leaves out symbols when asked', () => {
    for (let i = 0; i < 1000; i++) {
      const password = generatePassword({ symbols: false });
      expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
      expect(password).toMatch(HAS_LOWER);
      expect(password).toMatch(HAS_UPPER);
      expect(password).toMatch(HAS_DIGIT);
      expect(password).not.toMatch(AMBIGUOUS);
    }
  });

  it('uses the full ASCII range when look-alikes are allowed', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      for (const char of generatePassword({ avoidAmbiguous: false })) seen.add(char);
    }
    // Every printable ASCII character except the space.
    expect(seen.size).toBe(94);
    expect([...seen].join('')).toMatch(PRINTABLE_ASCII);
  });

  it('uses exactly the unambiguous alphabet by default', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) for (const char of generatePassword()) seen.add(char);
    const expected = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#$%&*+-=?@^_';
    expect([...seen].sort().join('')).toBe([...expected].sort().join(''));
  });

  it('contains every class even at the minimum length', () => {
    for (let i = 0; i < 500; i++) {
      const password = generatePassword({ length: 4 });
      expect(password).toHaveLength(4);
      expect(password).toMatch(HAS_LOWER);
      expect(password).toMatch(HAS_UPPER);
      expect(password).toMatch(HAS_DIGIT);
      expect(password).toMatch(HAS_SYMBOL);
    }
    for (let i = 0; i < 500; i++) {
      expect(generatePassword({ length: 3, symbols: false })).toMatch(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])[A-Za-z0-9]{3}$/,
      );
    }
  });

  it('clamps the length to what is possible', () => {
    expect(generatePassword({ length: 0 })).toHaveLength(4);
    expect(generatePassword({ length: -5 })).toHaveLength(4);
    expect(generatePassword({ length: 1, symbols: false })).toHaveLength(3);
    expect(generatePassword({ length: 12.9 })).toHaveLength(12);
    expect(generatePassword({ length: 1000 })).toHaveLength(MAX_PASSWORD_LENGTH);
    expect(generatePassword({ length: Number.NaN })).toHaveLength(DEFAULT_PASSWORD_LENGTH);
    expect(generatePassword({ length: Number.POSITIVE_INFINITY })).toHaveLength(
      MAX_PASSWORD_LENGTH,
    );
  });

  it('honours every length in between', () => {
    for (let length = 4; length <= MAX_PASSWORD_LENGTH; length++) {
      expect(generatePassword({ length })).toHaveLength(length);
    }
  });

  it('does not repeat itself', () => {
    const passwords = new Set(Array.from({ length: 5000 }, () => generatePassword()));
    expect(passwords.size).toBe(5000);
  });

  it('draws from crypto.getRandomValues', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    try {
      generatePassword();
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0]![0]).toBeInstanceOf(Uint32Array);
    } finally {
      spy.mockRestore();
    }
  });

  it('is fully determined by the random source', () => {
    // Alphabet without symbols and with look-alikes: a-z A-Z 0-9 (62). Index = word % 62.
    const words = [0, 26, 52, 61, 1, 27, 53, 25];
    const password = generatePassword(
      { length: 8, symbols: false, avoidAmbiguous: false },
      scripted([...words, ...new Array<number>(56).fill(0)]),
    );
    expect(password).toBe('aA09bB1z');
  });

  it('draws a fresh candidate when a class is missing', () => {
    // First candidate "aaaa" has no upper case or digit; the second one is complete.
    const source = scripted([0, 0, 0, 0, 0, 26, 52, 1, ...new Array<number>(56).fill(0)]);
    const password = generatePassword({ length: 4, symbols: false, avoidAmbiguous: false }, source);
    expect(password).toBe('aA0b');
  });

  it('spreads characters evenly within each class and over all positions', () => {
    const samples = 30_000;
    const length = 20;
    const counts = new Map<string, number>();
    const digitsAt = new Array<number>(length).fill(0);
    for (let i = 0; i < samples; i++) {
      const password = generatePassword({ length });
      for (let position = 0; position < length; position++) {
        const char = password[position]!;
        counts.set(char, (counts.get(char) ?? 0) + 1);
        if (HAS_DIGIT.test(char)) digitsAt[position]!++;
      }
    }
    expect(counts.size).toBe(69);

    // Requiring every class makes the small classes slightly more frequent overall (digits by
    // about 9 %), but inside a class every character must be equally likely.
    const classes = [HAS_LOWER, HAS_UPPER, HAS_DIGIT, HAS_SYMBOL];
    for (const pattern of classes) {
      const members = [...counts].filter(([char]) => pattern.test(char));
      const mean = members.reduce((sum, [, count]) => sum + count, 0) / members.length;
      for (const [char, count] of members) {
        expect(Math.abs(count - mean) / mean, char).toBeLessThan(0.06);
      }
    }

    // No position is special: "one of each class first, then fill up" without a proper shuffle
    // would put far more digits at the front.
    const digitShare = digitsAt.reduce((sum, count) => sum + count, 0) / (samples * length);
    expect(digitShare).toBeGreaterThan(8 / 69);
    expect(digitShare).toBeLessThan((8 / 69) * 1.15);
    for (const count of digitsAt) {
      expect(Math.abs(count / samples - digitShare)).toBeLessThan(0.012);
    }
  });
});

describe('createUniformPicker', () => {
  it('rejects values from the incomplete last range instead of wrapping them', () => {
    // For bound 3, 2^32 = 3 * 1431655765 + 1: only 0xFFFFFFFF must be rejected.
    const source = scripted([
      0xffffffff,
      0xfffffffe,
      0xffffffff,
      0xffffffff,
      7,
      ...new Array<number>(59).fill(5),
    ]);
    const pick = createUniformPicker(source);
    expect(pick(3)).toBe(0xfffffffe % 3);
    expect(pick(3)).toBe(7 % 3);
  });

  it('rejects half of the range for a bound just above a power of two', () => {
    const bound = 2 ** 31 + 1;
    const pick = createUniformPicker(
      scripted([bound, bound + 5, 0xffffffff, bound - 1, ...new Array<number>(60).fill(1)]),
    );
    expect(pick(bound)).toBe(bound - 1);
  });

  it('stays within bounds and hits every value', () => {
    const pick = createUniformPicker();
    for (const bound of [1, 2, 3, 7, 62, 69, 94, 1000]) {
      const seen = new Set<number>();
      for (let i = 0; i < bound * 60; i++) {
        const value = pick(bound);
        expect(Number.isInteger(value) && value >= 0 && value < bound).toBe(true);
        seen.add(value);
      }
      expect(seen.size).toBe(bound);
    }
  });

  it('passes a chi-square test for a bound that does not divide 2^32', () => {
    const pick = createUniformPicker();
    const bound = 69;
    const draws = 690_000;
    const counts = new Array<number>(bound).fill(0);
    for (let i = 0; i < draws; i++) counts[pick(bound)]!++;
    const expected = draws / bound;
    const chiSquare = counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    // 68 degrees of freedom: the 99.99th percentile is about 121.
    expect(chiSquare).toBeLessThan(125);
  });

  it('validates the bound', () => {
    const pick = createUniformPicker();
    for (const bound of [0, -1, 1.5, Number.NaN, 2 ** 32 + 1]) {
      expect(() => pick(bound)).toThrow(RangeError);
    }
    expect(pick(1)).toBe(0);
  });

  it('refills its pool and wipes used words', () => {
    const buffers: Uint32Array[] = [];
    const pick = createUniformPicker((array) => {
      buffers.push(array);
      crypto.getRandomValues(array);
    });
    for (let i = 0; i < 200; i++) pick(10);
    expect(buffers.length).toBeGreaterThanOrEqual(3);
    const pool = buffers[0]!;
    // Everything consumed so far has been zeroed.
    const consumed = 200 % pool.length || pool.length;
    expect([...pool.subarray(0, Math.min(consumed, 8))].every((word) => word === 0)).toBe(true);
  });
});
