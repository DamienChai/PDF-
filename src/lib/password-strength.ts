/**
 * Offline password strength estimate.
 *
 * The password is decomposed into the cheapest sequence of guessable patterns (common passwords,
 * pinyin names, a word decorated with digits, keyboard walks, sequences, repeats, dates) and
 * random-looking characters, in the manner of zxcvbn but with a compact dictionary. The result
 * is the entropy an attacker who knows these patterns has to search, in bits.
 *
 * The scale is calibrated for offline attacks: an encrypted PDF can be tested against millions of
 * candidate passwords per second without any rate limit.
 */
import {
  COMMON_PASSWORDS,
  LONGEST_COMMON_PASSWORD,
  LONGEST_PINYIN_SYLLABLE,
  PINYIN_SYLLABLES,
  isUsualLetterPair,
} from './common-passwords';

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

/** Machine-readable hints; the UI localises them. */
export type StrengthHint =
  | 'too-short'
  | 'common-password'
  | 'name-or-word'
  | 'repeated-characters'
  | 'sequence'
  | 'single-character-class'
  | 'looks-like-date';

export interface StrengthEstimate {
  /** 0 = very weak … 4 = very strong. An empty password scores 0. */
  score: StrengthScore;
  /** Estimated entropy in bits (after pattern penalties). */
  bits: number;
  hints: StrengthHint[];
}

/**
 * Lower bounds, in bits, for the scores 1…4. At 10⁷ guesses per second (one GPU against the
 * AES-128 handler) 28 bits last seconds, 44 bits about three weeks, 60 bits a few thousand years;
 * 80 bits is out of reach for any realistic attacker.
 */
const SCORE_THRESHOLDS = [28, 44, 60, 80] as const;

const MIN_LENGTH = 8;
/** PDF passwords are limited to 127 bytes; anything longer is analysed in pieces of this size. */
const PIECE_LENGTH = 128;
const MAX_PIECES = 4;
const MIN_DICTIONARY_LENGTH = 4;

type PatternKind = 'dictionary' | 'name' | 'word' | 'sequence' | 'keyboard' | 'repeat' | 'date';

interface Pattern {
  start: number;
  /** Exclusive. */
  end: number;
  bits: number;
  kind: PatternKind;
}

const HINT_FOR: Record<PatternKind, StrengthHint> = {
  dictionary: 'common-password',
  name: 'name-or-word',
  word: 'name-or-word',
  sequence: 'sequence',
  keyboard: 'sequence',
  repeat: 'repeated-characters',
  date: 'looks-like-date',
};

const HINT_ORDER: readonly StrengthHint[] = [
  'too-short',
  'common-password',
  'name-or-word',
  'repeated-characters',
  'sequence',
  'single-character-class',
  'looks-like-date',
];

// --- Character classes -------------------------------------------------------------------------

type CharClass = 'lower' | 'upper' | 'digit' | 'symbol' | 'other';

const CLASS_SIZE: Record<CharClass, number> = {
  lower: 26,
  upper: 26,
  digit: 10,
  symbol: 33,
  // Accented letters, CJK, emoji …: far more exist, but people pick from a small familiar set.
  other: 100,
};

function classOf(char: string): CharClass {
  const code = char.codePointAt(0)!;
  if (code >= 97 && code <= 122) return 'lower';
  if (code >= 65 && code <= 90) return 'upper';
  if (code >= 48 && code <= 57) return 'digit';
  return code < 128 ? 'symbol' : 'other';
}

function isDigit(char: string | undefined): char is string {
  return char !== undefined && char >= '0' && char <= '9';
}

// --- Dictionary --------------------------------------------------------------------------------

const LEET: Readonly<Record<string, string>> = {
  '@': 'a',
  '4': 'a',
  '8': 'b',
  '(': 'c',
  '3': 'e',
  '6': 'g',
  '9': 'g',
  '#': 'h',
  '!': 'i',
  '1': 'l',
  '|': 'l',
  '0': 'o',
  $: 's',
  '5': 's',
  '7': 't',
  '+': 't',
  '2': 'z',
};

function unleet(chars: readonly string[], one: string): string[] {
  return chars.map((char) => (char === '1' ? one : (LEET[char] ?? char)));
}

function binomial(n: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

/** Extra guesses for the way a dictionary word is capitalised. */
function capitalisationBits(token: readonly string[]): number {
  let upper = 0;
  let lower = 0;
  for (const char of token) {
    const charClass = classOf(char);
    if (charClass === 'upper') upper++;
    else if (charClass === 'lower') lower++;
  }
  if (upper === 0) return 0;
  // "Password", "PASSWORD" and "passworD" are the first things an attacker tries.
  const first = classOf(token[0]!) === 'upper';
  const last = classOf(token[token.length - 1]!) === 'upper';
  if (lower === 0 || (upper === 1 && (first || last))) return 1;
  let variations = 0;
  for (let i = 1; i <= Math.min(upper, lower); i++) variations += binomial(upper + lower, i);
  return Math.log2(variations);
}

function dictionaryPatterns(chars: readonly string[]): Pattern[] {
  const lower = chars.map((char) => char.toLowerCase());
  const variants: { text: string[]; extraBits: number }[] = [{ text: lower, extraBits: 0 }];
  if (lower.some((char) => char in LEET)) {
    variants.push({ text: unleet(lower, 'l'), extraBits: 1 });
    if (lower.includes('1')) variants.push({ text: unleet(lower, 'i'), extraBits: 1 });
  }

  const patterns: Pattern[] = [];
  for (let start = 0; start < chars.length; start++) {
    const longest = Math.min(chars.length - start, LONGEST_COMMON_PASSWORD);
    for (let length = MIN_DICTIONARY_LENGTH; length <= longest; length++) {
      const end = start + length;
      let best = Infinity;
      for (const variant of variants) {
        const slice = variant.text.slice(start, end);
        const forward = COMMON_PASSWORDS.get(slice.join(''));
        if (forward !== undefined)
          best = Math.min(best, Math.log2(forward + 1) + variant.extraBits);
        const backward = COMMON_PASSWORDS.get(slice.reverse().join(''));
        if (backward !== undefined) {
          best = Math.min(best, Math.log2(backward + 1) + variant.extraBits + 1);
        }
      }
      if (best < Infinity) {
        const bits = best + capitalisationBits(chars.slice(start, end));
        patterns.push({ start, end, bits, kind: 'dictionary' });
      }
    }
  }
  return patterns;
}

// --- Pinyin names ("zhangwei", "LiuYang", "wangxiaoming") ----------------------------------------

const SYLLABLE_BITS = Math.log2(PINYIN_SYLLABLES.size);
/** The handful of characters people put between two parts of a password: "-", ".", "_", "@" … */
const SEPARATOR_BITS = 3;
/** Surname and given name, with room for a compound surname or a word in front. */
const MAX_SYLLABLES = 5;

function pinyinPatterns(chars: readonly string[]): Pattern[] {
  const lower = chars.map((char) => char.toLowerCase());
  const patterns: Pattern[] = [];
  for (let start = 0; start < chars.length; start++) {
    // Fewest bits that lead from `start` to each end in `count` whole syllables.
    let reached = new Map<number, number>([[start, 0]]);
    for (let count = 1; count <= MAX_SYLLABLES && reached.size > 0; count++) {
      const next = new Map<number, number>();
      for (const [end, bits] of reached) {
        // "zhang-wei", "Zhang.Wei": one separator between two syllables changes little.
        const separated = count > 1 && end < chars.length && classOf(chars[end]!) === 'symbol';
        const starts: [number, number][] = [[end, bits]];
        if (separated) starts.push([end + 1, bits + SEPARATOR_BITS]);
        for (const [from, before] of starts) {
          const longest = Math.min(LONGEST_PINYIN_SYLLABLE, chars.length - from);
          for (let length = 2; length <= longest; length++) {
            const to = from + length;
            if (!PINYIN_SYLLABLES.has(lower.slice(from, to).join(''))) continue;
            const total = before + SYLLABLE_BITS + capitalisationBits(chars.slice(from, to));
            if (total < (next.get(to) ?? Infinity)) next.set(to, total);
          }
        }
      }
      for (const [end, bits] of next) {
        // Too short to call a name: random letters contain plenty of such syllables.
        if (end - start >= (count > 1 ? 5 : 4)) patterns.push({ start, end, bits, kind: 'name' });
      }
      reached = next;
    }
  }
  return patterns;
}

// --- Words decorated with digits ("Company2025", "Company@2025", "John.Smith.1985") --------------

const MAX_WORD_LENGTH = 16;
const MAX_WORD_DIGITS = 8;
/** "John.Smith", "MyCompany": more parts than this and it is a passphrase, judged as it comes. */
const MAX_WORD_PARTS = 3;
/** Symbols between the last word and the digits behind it; more than two cost more each. */
const MAX_SEPARATORS = 4;
const USUAL_SEPARATORS = 2;
const MAX_LEADING_SYMBOLS = 2;
const MAX_TRAILING_SYMBOLS = 2;
/** "Tr0ub4dor": more replaced letters than this and it is no longer taken for a word. */
const MAX_WORD_SUBSTITUTIONS = 2;
const SUBSTITUTION_BITS = 2;
const VOWELS = new Set('aeiouy');

function isLetter(char: string | undefined): char is string {
  if (char === undefined) return false;
  const charClass = classOf(char);
  return charClass === 'lower' || charClass === 'upper';
}

function isSymbol(char: string | undefined): char is string {
  return char !== undefined && classOf(char) === 'symbol';
}

/**
 * True for letters that read like a word or a name: written the way words are (lower case,
 * Capitalised or CAPITALS), with a vowel, and with nothing but usual letter pairs. Without a
 * dictionary this is as close as it gets: "xkqmvlpt" is not taken for a word, a made-up
 * "bolaxi" is. `spelled` is the same text in lower case with replaced letters put back.
 */
function looksLikeWord(letters: readonly string[], spelled: readonly string[]): boolean {
  const upper = letters.filter((char) => classOf(char) === 'upper').length;
  const usualCase =
    upper === 0 || upper === letters.length || (upper === 1 && classOf(letters[0]!) === 'upper');
  if (!usualCase) return false;
  return (
    spelled.some((char) => VOWELS.has(char)) &&
    spelled.every((char, index) => index === 0 || isUsualLetterPair(spelled[index - 1]!, char))
  );
}

/** A word counts as an entry of a list of a few million, somewhat more for long words. */
function wordBits(letters: readonly string[]): number {
  return (
    Math.min(letters.length * Math.log2(26), 16 + 0.75 * letters.length) +
    capitalisationBits(letters)
  );
}

/** The symbols between the last word and the digits: the usual one or two, a repeat, or more. */
function separatorBits(symbols: readonly string[]): number {
  if (symbols.length <= USUAL_SEPARATORS) return symbols.length * SEPARATOR_BITS;
  if (symbols.every((char) => char === symbols[0])) {
    return SEPARATOR_BITS + Math.log2(symbols.length);
  }
  return (
    USUAL_SEPARATORS * SEPARATOR_BITS +
    (symbols.length - USUAL_SEPARATORS) * Math.log2(CLASS_SIZE.symbol)
  );
}

interface Words {
  /** Where the last word ends (exclusive). */
  end: number;
  bits: number;
}

/** One word from `start`, possibly with a letter or two replaced by look-alikes. */
function singleWord(chars: readonly string[], start: number, lookAlikes: boolean): Words | null {
  // Letters, possibly with look-alikes among them, from a letter to a letter.
  let end = start;
  while (end < chars.length && (isLetter(chars[end]) || chars[end]! in LEET)) end++;
  while (end > start && !isLetter(chars[end - 1])) end--;
  const length = end - start;
  if (length < 3 || length > MAX_WORD_LENGTH) return null;
  const word = chars.slice(start, end);
  const letters = word.filter(isLetter);
  const substitutions = word.length - letters.length;
  if (substitutions > (lookAlikes ? MAX_WORD_SUBSTITUTIONS : 0)) return null;
  const lower = word.map((char) => char.toLowerCase());
  const spellings = substitutions === 0 ? [lower] : [unleet(lower, 'l'), unleet(lower, 'i')];
  if (!spellings.some((spelled) => looksLikeWord(letters, spelled))) return null;
  return {
    end,
    bits:
      Math.min(length * Math.log2(26), 16 + 0.75 * length) +
      capitalisationBits(letters) +
      substitutions * SUBSTITUTION_BITS,
  };
}

/**
 * Two or three words from `start`: joined by one symbol each ("john.smith", "my_company"), or
 * written together with a capital where the next one begins ("HelloKitty").
 */
function severalWords(chars: readonly string[], start: number): Words | null {
  let bits = 0;
  let parts = 0;
  let at = start;
  for (;;) {
    let end = at;
    while (isLetter(chars[end])) {
      // A capital behind a small letter begins the next word.
      if (end > at && classOf(chars[end]!) === 'upper' && classOf(chars[end - 1]!) === 'lower') {
        break;
      }
      end++;
    }
    const letters = chars.slice(at, end);
    const spelled = letters.map((char) => char.toLowerCase());
    if (letters.length < 2 || letters.length > MAX_WORD_LENGTH) return null;
    if (!looksLikeWord(letters, spelled) || ++parts > MAX_WORD_PARTS) return null;
    bits += wordBits(letters);
    if (isLetter(chars[end])) {
      at = end;
    } else if (isSymbol(chars[end]) && isLetter(chars[end + 1])) {
      bits += SEPARATOR_BITS;
      at = end + 1;
    } else {
      // Two letters alone are no word; next to another word they are ("my", "Li").
      return parts > 1 && end - start >= 6 ? { end, bits } : null;
    }
  }
}

/**
 * The whole password is a word, or two or three of them, with decorations: digits in front or
 * behind, with or without a separator ("Company@2025", "2025-Company", "John.Smith.1985"), a
 * symbol or two at the very start or end. These are the shapes every guessing tool derives from
 * its word and name lists ("append a year", "append @123", "prepend digits", "first name, dot,
 * last name"), also for a word with a letter or two replaced by look-alikes ("Tr0ub4dor&3"). A
 * word then counts as an entry of such a list, not as letters chosen at random. Digits and
 * trailing symbols are judged separately.
 */
function wordPatterns(chars: readonly string[]): Pattern[] {
  let leading = 0;
  while (isSymbol(chars[leading])) leading++;
  let start = leading;
  while (isDigit(chars[start])) start++;
  const digitsBefore = start - leading;
  // "2025-Company": one separator between the digits in front and the word.
  const joined = digitsBefore > 0 && isSymbol(chars[start]) && isLetter(chars[start + 1]);
  if (joined) start++;
  if (leading > MAX_LEADING_SYMBOLS || digitsBefore > MAX_WORD_DIGITS || !isLetter(chars[start])) {
    return [];
  }

  // Behind digits, look-alikes are not accepted: random letters and digits would qualify too often.
  const candidates = [singleWord(chars, start, digitsBefore === 0), severalWords(chars, start)];
  const patterns: Pattern[] = [];
  for (const words of candidates) {
    if (!words) continue;
    const { end } = words;
    let separatorsEnd = end;
    while (isSymbol(chars[separatorsEnd])) separatorsEnd++;
    let digitsEnd = separatorsEnd;
    while (isDigit(chars[digitsEnd])) digitsEnd++;
    let symbolsEnd = digitsEnd;
    while (isSymbol(chars[symbolsEnd])) symbolsEnd++;

    const digits = digitsEnd - separatorsEnd;
    // Without digits behind them the "separators" are the symbols at the end.
    const separators = digits > 0 ? separatorsEnd - end : 0;
    if (
      symbolsEnd !== chars.length ||
      digits > MAX_WORD_DIGITS ||
      digitsBefore + digits < 1 ||
      separators > MAX_SEPARATORS ||
      symbolsEnd - digitsEnd + (digits > 0 ? 0 : separatorsEnd - end) > MAX_TRAILING_SYMBOLS
    ) {
      continue;
    }
    // Symbols at the very start belong to the pattern where nothing lies between them and the
    // word; behind them come digits otherwise, and they count as any other character.
    const from = digitsBefore === 0 ? 0 : start - (joined ? 1 : 0);
    const bits =
      words.bits +
      (digitsBefore === 0 ? leading : joined ? 1 : 0) * SEPARATOR_BITS +
      separatorBits(chars.slice(end, end + separators));
    patterns.push({ start: from, end: end + separators, bits, kind: 'word' });
  }
  return patterns;
}

// --- Sequences ("abcdef", "9876", "2468") ------------------------------------------------------

const OBVIOUS_SEQUENCE_STARTS = new Set(['a', 'A', 'z', 'Z', '0', '1', '9']);

function sequenceBits(first: string, length: number, delta: number): number {
  let guesses: number;
  if (OBVIOUS_SEQUENCE_STARTS.has(first)) guesses = 4;
  else if (isDigit(first)) guesses = 10;
  else guesses = 26;
  if (classOf(first) === 'upper') guesses *= 2;
  if (delta < 0) guesses *= 2;
  return Math.log2(guesses * Math.abs(delta) * length);
}

/** Adds [start, end) and every prefix and suffix that is still long enough. */
function pushWithEnds(
  patterns: Pattern[],
  start: number,
  end: number,
  minLength: number,
  kind: PatternKind,
  bitsFor: (from: number, to: number) => number,
): void {
  patterns.push({ start, end, bits: bitsFor(start, end), kind });
  for (let cut = start + minLength; cut < end; cut++) {
    patterns.push({ start, end: cut, bits: bitsFor(start, cut), kind });
  }
  for (let cut = start + 1; cut <= end - minLength; cut++) {
    patterns.push({ start: cut, end, bits: bitsFor(cut, end), kind });
  }
}

function sequencePatterns(chars: readonly string[]): Pattern[] {
  const patterns: Pattern[] = [];
  const codes = chars.map((char) => char.codePointAt(0)!);
  let start = 0;
  while (start < chars.length - 1) {
    const delta = codes[start + 1]! - codes[start]!;
    const charClass = classOf(chars[start]!);
    const sequenceable = charClass === 'lower' || charClass === 'upper' || charClass === 'digit';
    if (!sequenceable || delta === 0 || Math.abs(delta) > 5) {
      start++;
      continue;
    }
    let end = start + 1;
    while (
      end < chars.length &&
      codes[end]! - codes[end - 1]! === delta &&
      classOf(chars[end]!) === charClass
    ) {
      end++;
    }
    // Steps of one are recognisable from three characters on, wider steps need four.
    const minLength = Math.abs(delta) === 1 ? 3 : 4;
    if (end - start >= minLength) {
      pushWithEnds(patterns, start, end, minLength, 'sequence', (from, to) =>
        sequenceBits(chars[from]!, to - from, delta),
      );
    }
    // The last character of a run may start the next one ("abcdcba").
    start = Math.max(start + 1, end - 1);
  }
  return patterns;
}

// --- Keyboard walks ("qwerty", "1qaz2wsx", "zxcvbn") -------------------------------------------

/** QWERTY rows with the horizontal offset of their first key, in key widths. */
const KEYBOARD_ROWS: readonly (readonly [number, string, string])[] = [
  [0, '`1234567890-=', '~!@#$%^&*()_+'],
  [1.5, 'qwertyuiop[]\\', 'QWERTYUIOP{}|'],
  [1.75, "asdfghjkl;'", 'ASDFGHJKL:"'],
  [2.25, 'zxcvbnm,./', 'ZXCVBNM<>?'],
];

interface Key {
  row: number;
  x: number;
  shifted: boolean;
}

const KEYS: ReadonlyMap<string, Key> = (() => {
  const keys = new Map<string, Key>();
  KEYBOARD_ROWS.forEach(([offset, plain, shifted], row) => {
    [...plain].forEach((char, index) => keys.set(char, { row, x: offset + index, shifted: false }));
    [...shifted].forEach((char, index) =>
      keys.set(char, { row, x: offset + index, shifted: true }),
    );
  });
  return keys;
})();

const KEY_COUNT = 47;
/** Average number of neighbours of a key. */
const KEY_DEGREE = 4.6;
const MIN_WALK_LENGTH = 4;

/** Direction of the step between two neighbouring keys, or null if they are not neighbours. */
function keyStep(from: Key, to: Key): string | null {
  const rows = to.row - from.row;
  const dx = to.x - from.x;
  if (rows === 0) return Math.abs(dx) === 1 ? `0:${dx}` : null;
  if (Math.abs(rows) === 1 && Math.abs(dx) < 1) return `${rows}:${Math.sign(dx)}`;
  return null;
}

function keyboardBits(length: number, turns: number, shifted: number): number {
  let guesses = 0;
  for (let i = 2; i <= length; i++) {
    for (let j = 1; j <= Math.min(turns, i - 1); j++) {
      guesses += binomial(i - 1, j - 1) * KEY_COUNT * KEY_DEGREE ** j;
    }
  }
  let bits = Math.log2(guesses);
  if (shifted > 0) {
    const unshifted = length - shifted;
    if (unshifted === 0) {
      bits += 1;
    } else {
      let variations = 0;
      for (let i = 1; i <= Math.min(shifted, unshifted); i++) variations += binomial(length, i);
      bits += Math.log2(variations);
    }
  }
  return bits;
}

function keyboardPatterns(chars: readonly string[]): Pattern[] {
  const patterns: Pattern[] = [];
  const keys = chars.map((char) => KEYS.get(char));
  const walkBits = (from: number, to: number): number => {
    let turns = 0;
    let shifted = keys[from]!.shifted ? 1 : 0;
    let previous: string | null = null;
    for (let i = from + 1; i < to; i++) {
      const step = keyStep(keys[i - 1]!, keys[i]!);
      if (step !== previous) turns++;
      previous = step;
      if (keys[i]!.shifted) shifted++;
    }
    return keyboardBits(to - from, turns, shifted);
  };

  let start = 0;
  while (start < chars.length - 1) {
    let end = start + 1;
    while (
      end < chars.length &&
      keys[end - 1] !== undefined &&
      keys[end] !== undefined &&
      keyStep(keys[end - 1]!, keys[end]!) !== null
    ) {
      end++;
    }
    if (end - start >= MIN_WALK_LENGTH) {
      pushWithEnds(patterns, start, end, MIN_WALK_LENGTH, 'keyboard', walkBits);
    }
    start = end;
  }
  return patterns;
}

// --- Repeats ("aaaa", "abcabcabc") -------------------------------------------------------------

const MAX_REPEAT_BASE = 32;

function repeatPatterns(chars: readonly string[], depth: number): Pattern[] {
  const patterns: Pattern[] = [];

  // One character, three times or more.
  let start = 0;
  while (start < chars.length) {
    let end = start + 1;
    while (end < chars.length && chars[end] === chars[start]) end++;
    if (end - start >= 3) {
      const charBits = Math.log2(CLASS_SIZE[classOf(chars[start]!)]);
      pushWithEnds(
        patterns,
        start,
        end,
        3,
        'repeat',
        (from, to) => charBits + Math.log2(to - from),
      );
    }
    start = end;
  }

  // A block of two or more characters, twice or more. Its own strength is estimated recursively
  // ("123123" is a repeated sequence), one level deep.
  if (depth > 0) return patterns;
  const baseBits = new Map<string, number>();
  for (let from = 0; from < chars.length; from++) {
    const longest = Math.min(MAX_REPEAT_BASE, (chars.length - from) >> 1);
    for (let size = 2; size <= longest; size++) {
      let count = 1;
      while (matchesAt(chars, from, from + count * size, size)) count++;
      if (count < 2) continue;
      const base = chars.slice(from, from + size);
      if (base.every((char) => char === base[0])) continue;
      const key = base.join('');
      let bits = baseBits.get(key);
      if (bits === undefined) {
        bits = analyse(base, depth + 1).bits;
        baseBits.set(key, bits);
      }
      for (let repeats = 2; repeats <= count; repeats++) {
        patterns.push({
          start: from,
          end: from + repeats * size,
          bits: bits + Math.log2(repeats),
          kind: 'repeat',
        });
      }
    }
  }
  return patterns;
}

function matchesAt(chars: readonly string[], a: number, b: number, size: number): boolean {
  if (b + size > chars.length) return false;
  for (let i = 0; i < size; i++) if (chars[a + i] !== chars[b + i]) return false;
  return true;
}

// --- Dates and years ---------------------------------------------------------------------------

const REFERENCE_YEAR = new Date().getFullYear();
const MIN_YEAR = 1900;
const MAX_YEAR = 2099;
const DATE_SEPARATORS = new Set(['-', '/', '.', '_', ' ']);

function isYear(value: number): boolean {
  return value >= MIN_YEAR && value <= MAX_YEAR;
}

function isDayMonth(a: number, b: number): boolean {
  return (a >= 1 && a <= 31 && b >= 1 && b <= 12) || (a >= 1 && a <= 12 && b >= 1 && b <= 31);
}

function yearBits(year: number): number {
  return Math.log2(Math.max(Math.abs(year - REFERENCE_YEAR), 20));
}

function fullYear(twoDigits: number): number {
  const year = 2000 + twoDigits;
  return year > REFERENCE_YEAR ? year - 100 : year;
}

function number(chars: readonly string[], start: number, end: number): number {
  return Number(chars.slice(start, end).join(''));
}

/** Bits of a date written with the given field widths starting at `start`, or null. */
function dateBits(
  chars: readonly string[],
  start: number,
  widths: readonly [number, number, number],
): number | null {
  const a = number(chars, start, start + widths[0]);
  const b = number(chars, start + widths[0], start + widths[0] + widths[1]);
  const c = number(chars, start + widths[0] + widths[1], start + widths[0] + widths[1] + widths[2]);
  let year: number;
  if (widths[0] === 4) {
    if (!isYear(a) || !isDayMonth(b, c)) return null;
    year = a;
  } else if (widths[2] === 4) {
    if (!isYear(c) || !isDayMonth(a, b)) return null;
    year = c;
  } else if (isDayMonth(a, b)) {
    year = fullYear(c);
  } else if (isDayMonth(b, c)) {
    year = fullYear(a);
  } else {
    return null;
  }
  return Math.log2(365) + yearBits(year);
}

const DIGIT_DATE_LAYOUTS: readonly (readonly [number, number, number])[] = [
  [4, 2, 2],
  [2, 2, 4],
  [2, 2, 2],
];

function datePatterns(chars: readonly string[]): Pattern[] {
  const patterns: Pattern[] = [];
  const digitRunEnd = (from: number): number => {
    let end = from;
    while (isDigit(chars[end])) end++;
    return end;
  };

  for (let start = 0; start < chars.length; start++) {
    if (!isDigit(chars[start])) continue;
    const run = digitRunEnd(start) - start;

    // Bare years: "1987", "2024".
    if (run >= 4) {
      const year = number(chars, start, start + 4);
      if (isYear(year)) {
        patterns.push({ start, end: start + 4, bits: yearBits(year), kind: 'date' });
      }
    }

    // Digits only: 20240131, 31012024, 240131.
    for (const widths of DIGIT_DATE_LAYOUTS) {
      const length = widths[0] + widths[1] + widths[2];
      if (run < length) continue;
      const bits = dateBits(chars, start, widths);
      if (bits !== null) patterns.push({ start, end: start + length, bits, kind: 'date' });
    }

    // With separators: 2024-01-31, 31/1/2024, 1.2.87.
    if (start > 0 && isDigit(chars[start - 1])) continue;
    const firstEnd = digitRunEnd(start);
    const separator = chars[firstEnd];
    if (separator === undefined || !DATE_SEPARATORS.has(separator)) continue;
    const secondEnd = digitRunEnd(firstEnd + 1);
    if (chars[secondEnd] !== separator) continue;
    const thirdEnd = digitRunEnd(secondEnd + 1);
    const widths = [firstEnd - start, secondEnd - firstEnd - 1, thirdEnd - secondEnd - 1] as const;
    const plausible =
      widths[1] >= 1 &&
      widths[1] <= 2 &&
      ((widths[0] === 4 && widths[2] >= 1 && widths[2] <= 2) ||
        (widths[0] >= 1 && widths[0] <= 2 && (widths[2] === 4 || widths[2] === 2)));
    if (!plausible) continue;
    const digits = [
      ...chars.slice(start, firstEnd),
      ...chars.slice(firstEnd + 1, secondEnd),
      ...chars.slice(secondEnd + 1, thirdEnd),
    ];
    const bits = dateBits(digits, 0, widths);
    // Two more bits for the choice of separator.
    if (bits !== null) patterns.push({ start, end: thirdEnd, bits: bits + 2, kind: 'date' });
  }
  return patterns;
}

// --- Cheapest decomposition --------------------------------------------------------------------

interface Analysis {
  bits: number;
  kinds: Set<PatternKind>;
}

function analyse(chars: readonly string[], depth: number): Analysis {
  const classes = new Set(chars.map(classOf));
  let pool = 0;
  for (const charClass of classes) pool += CLASS_SIZE[charClass];
  const charBits = Math.log2(pool);

  // Long inputs are analysed in pieces so that the work stays bounded (this runs on every key
  // press). Anything beyond the analysed part is ignored, which errs on the side of caution.
  const kinds = new Set<PatternKind>();
  const analysed = Math.min(chars.length, PIECE_LENGTH * MAX_PIECES);
  let bits = 0;
  let previous = '';
  for (let offset = 0; offset < analysed; offset += PIECE_LENGTH) {
    const piece = chars.slice(offset, Math.min(offset + PIECE_LENGTH, analysed));
    const text = piece.join('');
    if (text === previous) {
      // The same piece again: a repeat, however long the piece is.
      bits += 1;
      kinds.add('repeat');
    } else {
      bits += cheapestDecomposition(piece, charBits, depth, kinds);
    }
    previous = text;
  }
  return { bits, kinds };
}

/** Returns the bits of the cheapest way to produce `chars` and records the patterns it uses. */
function cheapestDecomposition(
  chars: readonly string[],
  charBits: number,
  depth: number,
  kinds: Set<PatternKind>,
): number {
  const patterns = [
    ...dictionaryPatterns(chars),
    ...pinyinPatterns(chars),
    ...wordPatterns(chars),
    ...sequencePatterns(chars),
    ...keyboardPatterns(chars),
    ...repeatPatterns(chars, depth),
    ...datePatterns(chars),
  ];
  const endingAt = new Map<number, Pattern[]>();
  for (const pattern of patterns) {
    const list = endingAt.get(pattern.end);
    if (list) list.push(pattern);
    else endingAt.set(pattern.end, [pattern]);
  }

  // best[k]: fewest bits needed to produce the first k characters.
  const best = new Float64Array(chars.length + 1);
  const chosen: (Pattern | null)[] = [null];
  for (let k = 1; k <= chars.length; k++) {
    best[k] = best[k - 1]! + charBits;
    chosen[k] = null;
    for (const pattern of endingAt.get(k) ?? []) {
      // An attacker also has to guess where in the password the pattern sits. This keeps a short
      // pattern that shows up by chance in a long random password from costing it much.
      const placement = Math.log2(chars.length - (pattern.end - pattern.start) + 1);
      const bits = best[pattern.start]! + pattern.bits + placement;
      if (bits < best[k]!) {
        best[k] = bits;
        chosen[k] = pattern;
      }
    }
  }

  for (let k = chars.length; k > 0;) {
    const pattern = chosen[k];
    if (pattern) {
      kinds.add(pattern.kind);
      k = pattern.start;
    } else {
      k--;
    }
  }
  return best[chars.length]!;
}

export function estimateStrength(password: string): StrengthEstimate {
  const chars = Array.from(password);
  if (chars.length === 0) return { score: 0, bits: 0, hints: [] };

  const { bits, kinds } = analyse(chars, 0);
  const score = SCORE_THRESHOLDS.filter((threshold) => bits >= threshold).length as StrengthScore;

  const hints = new Set<StrengthHint>();
  // A password that is already very strong needs no advice.
  if (score < 4) {
    if (chars.length < MIN_LENGTH) hints.add('too-short');
    for (const kind of kinds) hints.add(HINT_FOR[kind]);
    if (new Set(chars.map(classOf)).size === 1) hints.add('single-character-class');
  }

  return {
    score,
    bits: Math.round(bits * 10) / 10,
    hints: HINT_ORDER.filter((hint) => hints.has(hint)),
  };
}
