import { describe, expect, it } from 'vitest';
import {
  COMMON_PASSWORDS,
  LONGEST_COMMON_PASSWORD,
  LONGEST_PINYIN_SYLLABLE,
  PINYIN_SYLLABLES,
  isUsualLetterPair,
} from './common-passwords';
import { generatePassword } from './password-generator';
import { estimateStrength } from './password-strength';

/** Deterministic pseudo-random strings (mulberry32) so failures are reproducible. */
function randomStrings(alphabet: string, length: number, count: number, seed: number): string[] {
  let state = seed;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join(''),
  );
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const ALNUM = `${LOWER}${LOWER.toUpperCase()}0123456789`;

describe('common password list', () => {
  it('is a compact list of unique, lower-case entries', () => {
    const entries = [...COMMON_PASSWORDS.keys()];
    expect(entries.length).toBeGreaterThanOrEqual(200);
    expect(entries.length).toBeLessThanOrEqual(500);
    for (const entry of entries) expect(entry).toMatch(/^[a-z0-9]{4,16}$/);
    // Map construction would silently drop duplicates and shift ranks.
    expect(Math.max(...COMMON_PASSWORDS.values())).toBe(entries.length);
    expect(LONGEST_COMMON_PASSWORD).toBe(Math.max(...entries.map((entry) => entry.length)));
    expect(COMMON_PASSWORDS.get('123456')).toBe(1);
    expect(COMMON_PASSWORDS.get('password')).toBe(2);
  });
});

describe('pinyin syllables and letter pairs', () => {
  it('are compact: a few hundred short syllables, one row of letters per letter', () => {
    const syllables = [...PINYIN_SYLLABLES];
    expect(syllables.length).toBeGreaterThanOrEqual(150);
    expect(syllables.length).toBeLessThanOrEqual(300);
    for (const syllable of syllables) expect(syllable).toMatch(/^[a-z]{2,6}$/);
    expect(LONGEST_PINYIN_SYLLABLE).toBe(6);
    for (const surname of ['wang', 'li', 'zhang', 'liu', 'chen', 'ou', 'yang']) {
      expect(PINYIN_SYLLABLES.has(surname), surname).toBe(true);
    }
  });

  it('know which letters follow which in ordinary words', () => {
    const usual = (word: string): boolean =>
      [...word].every((char, i) => i === 0 || isUsualLetterPair(word[i - 1]!, char));
    for (const word of ['company', 'elephant', 'holiday', 'michael', 'summer', 'question']) {
      expect(usual(word), word).toBe(true);
    }
    for (const letters of ['xkqmvlpt', 'qzj', 'wvx', 'bq']) {
      expect(usual(letters), letters).toBe(false);
    }
    // Roughly half of all pairs: enough to tell words from random letters, not a dictionary.
    let pairs = 0;
    for (let a = 97; a < 123; a++) {
      for (let b = 97; b < 123; b++) {
        if (isUsualLetterPair(String.fromCharCode(a), String.fromCharCode(b))) pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(300);
    expect(pairs).toBeLessThan(420);
    expect(isUsualLetterPair('A', 'b')).toBe(false);
    expect(isUsualLetterPair('1', 'a')).toBe(false);
  });
});

describe('estimateStrength', () => {
  it('scores an empty password 0 without hints', () => {
    expect(estimateStrength('')).toEqual({ score: 0, bits: 0, hints: [] });
  });

  it('rates the most common passwords very weak', () => {
    for (const password of ['123456', 'password', 'qwerty', 'iloveyou', 'dragon', 'letmein']) {
      const estimate = estimateStrength(password);
      expect(estimate.score, password).toBe(0);
      expect(estimate.hints, password).toContain('common-password');
    }
    for (const password of COMMON_PASSWORDS.keys()) {
      expect(estimateStrength(password).score, password).toBe(0);
    }
  });

  it('is not fooled by "Password123!"', () => {
    const estimate = estimateStrength('Password123!');
    expect(estimate.score).toBe(0);
    expect(estimate.bits).toBeLessThan(28);
    expect(estimate.hints).toContain('common-password');
  });

  it('sees through capitalisation, leet spelling, reversal and decorations', () => {
    const disguised = [
      'Password',
      'PASSWORD',
      'passworD',
      'pAsSwOrD',
      'P@ssw0rd',
      'p4$$w0rd',
      'drowssap',
      'Password1',
      'Password!',
      'password2024',
      'Passw0rd!2023',
      'Qwerty123!',
      'Admin@123',
      'Welcome1!',
      'iloveyou!',
      'L3tm31n',
      'Summer2024!',
      'Dragon#1',
      'woaini1314',
      '!password!',
      'xXpasswordXx',
    ];
    for (const password of disguised) {
      const estimate = estimateStrength(password);
      expect(estimate.score, password).toBeLessThanOrEqual(1);
      expect(estimate.hints, password).toContain('common-password');
    }
  });

  it('does not rate a pinyin name above weak, whatever is put behind it', () => {
    const names = [
      'zhangwei123',
      'Zhangwei1990',
      'liuyang1988',
      'zhangwei',
      'wangxiaoming',
      'WangXiaoMing',
      'lihua520',
      'ZhangWei88',
      'liming2008',
      'chenjing0816',
      'LIUYANG2012',
      'zhaolei@163',
      'xiaoming!1999',
      'beijing2008',
      'shanghai1',
    ];
    for (const password of names) {
      const estimate = estimateStrength(password);
      expect(estimate.score, password).toBeLessThanOrEqual(1);
      expect(estimate.hints, password).toContain('name-or-word');
    }
    // A full name by itself is worth next to nothing.
    expect(estimateStrength('zhangwei').score).toBe(0);
    expect(estimateStrength('wangxiaoming').bits).toBeLessThan(28);
  });

  it('does not rate an ordinary word with digits behind it above weak', () => {
    const words = [
      'Company2025',
      'company2025',
      'COMPANY2025',
      'Company2025!',
      'holiday99',
      'Elephant7',
      'mittens2019',
      'guitarhero99',
      'international1',
      'Christopher123!',
      'window4821',
      'invoice20240131',
    ];
    for (const password of words) {
      const estimate = estimateStrength(password);
      expect(estimate.score, password).toBeLessThanOrEqual(1);
      expect(estimate.hints, password).toContain('name-or-word');
    }
    // The digits still count for what they are: eight random ones are worth something.
    expect(estimateStrength('company48302759').bits).toBeGreaterThan(
      estimateStrength('company2025').bits + 15,
    );
  });

  it('leaves alone what is not a word with digits', () => {
    const unchanged: [string, number][] = [
      // Letters nobody would read as a word, however they end.
      ['xkqmvlptrzwsjh42', 4],
      ['xkqmvlptrzwsjh', 3],
      ['hTkPzQwLmN42', 3],
      // Passphrases and mixed passwords.
      ['correct horse battery staple', 4],
      ['purple-monkey-dishwasher-42', 4],
      ['MyDogIsCalledRex2019!', 4],
      ['G8v$kPz3!rTq', 3],
      ['x7#Kq9!mZ2', 3],
      ['hT7$kPz2', 2],
    ];
    for (const [password, score] of unchanged) {
      const estimate = estimateStrength(password);
      expect(estimate.score, password).toBe(score);
      expect(estimate.hints, password).not.toContain('name-or-word');
    }
  });

  it('rarely takes random letters followed by digits for a word', () => {
    for (const [length, atLeast] of [
      [12, 3],
      [14, 3],
      [16, 4],
    ] as const) {
      const passwords = randomStrings(LOWER, length, 1000, 77 + length).map(
        (letters, index) => `${letters}${10 + (index % 90)}`,
      );
      const lowered = passwords.filter((password) => estimateStrength(password).score < atLeast);
      // Under 2 %: letter pairs are no dictionary, and chance sequences cost a level now and then.
      expect(lowered.length, `${length} letters`).toBeLessThan(20);
    }
  });

  it('recognises sequences and keyboard walks', () => {
    for (const password of [
      'abcdefgh',
      'hgfedcba',
      '98765432',
      'zxcvbnm,./',
      'ertyuiop[',
      '5tgb6yhn',
      'ZAQ!XSW@',
    ]) {
      const estimate = estimateStrength(password);
      expect(estimate.score, password).toBe(0);
      expect(estimate.hints, password).toContain('sequence');
    }
    expect(estimateStrength('13579bdfh').hints).toContain('sequence');
    expect(estimateStrength('xk7#abcdef').hints).toContain('sequence');
  });

  it('recognises repeats', () => {
    for (const password of [
      'aaaaaaaaaaaa',
      '7777777777',
      'abcabcabcabc',
      'xyxyxyxyxyxy',
      'Ab1!Ab1!Ab1!',
    ]) {
      const estimate = estimateStrength(password);
      expect(estimate.score, password).toBeLessThanOrEqual(1);
      expect(estimate.hints, password).toContain('repeated-characters');
    }
    // A repeated strong block is only as strong as the block.
    const block = 'hT7$kPz2';
    expect(estimateStrength(block.repeat(3)).bits).toBeLessThan(estimateStrength(block).bits + 8);
  });

  it('recognises dates and years', () => {
    const dates = [
      '19900101',
      '01011990',
      '31121999',
      '1990-01-01',
      '31/12/1999',
      '1.2.87',
      '900101',
    ];
    for (const password of dates) {
      const estimate = estimateStrength(password);
      expect(estimate.score, password).toBe(0);
      expect(estimate.hints, password).toContain('looks-like-date');
    }
    expect(estimateStrength('zhangwei1990').hints).toContain('looks-like-date');
    expect(estimateStrength('mittens2019').hints).toContain('looks-like-date');
    // Not dates: month 13, day 32, year out of range.
    expect(estimateStrength('99999999').hints).not.toContain('looks-like-date');
    expect(estimateStrength('48302759').hints).not.toContain('looks-like-date');
  });

  it('flags short and single-class passwords', () => {
    expect(estimateStrength('aB3$').hints).toEqual(['too-short']);
    expect(estimateStrength('hT7$kPz').hints).toEqual(['too-short']);
    expect(estimateStrength('hT7$kPz2').hints).toEqual([]);
    expect(estimateStrength('48302759').hints).toEqual(['single-character-class']);
    expect(estimateStrength('xkqmvlptrzwsjh').hints).toEqual(['single-character-class']);
    expect(estimateStrength('密码').hints).toEqual(['too-short', 'single-character-class']);
  });

  it('reports hints in a stable order', () => {
    expect(estimateStrength('aaa').hints).toEqual([
      'too-short',
      'repeated-characters',
      'single-character-class',
    ]);
    expect(estimateStrength('1234').hints).toEqual([
      'too-short',
      'common-password',
      'single-character-class',
    ]);
  });

  it('uses the whole scale for random passwords of growing length', () => {
    const scores = [4, 6, 8, 10, 12, 14, 16, 20].map((length) => {
      const [password] = randomStrings(ALNUM, length, 1, length);
      return estimateStrength(password!).score;
    });
    expect(scores).toEqual([...scores].sort());
    expect(scores[0]).toBe(0);
    expect(scores.at(-1)).toBe(4);
    expect(new Set(scores).size).toBe(5);
  });

  it('rates random passwords by their entropy', () => {
    const cases: [string, number, number][] = [
      // alphabet, length, expected score
      ['0123456789', 6, 0],
      ['0123456789', 8, 0],
      [LOWER, 8, 1],
      [ALNUM, 9, 2],
      [LOWER, 12, 2],
      [ALNUM, 12, 3],
      [LOWER, 16, 3],
      [ALNUM, 16, 4],
    ];
    for (const [alphabet, length, expected] of cases) {
      const passwords = randomStrings(alphabet, length, 200, length * alphabet.length);
      const scores = passwords.map((password) => estimateStrength(password).score);
      const hits = scores.filter((score) => score === expected).length;
      // Chance patterns may cost an occasional password a level; never more than a few.
      expect(hits, `${alphabet.length}^${length}`).toBeGreaterThanOrEqual(190);
      expect(Math.max(...scores)).toBeLessThanOrEqual(expected);
    }
  });

  it('rates 20-character random strings 4', () => {
    for (const password of randomStrings(ALNUM, 20, 2000, 1)) {
      expect(estimateStrength(password).score, password).toBe(4);
    }
    for (const symbols of [true, false]) {
      for (const avoidAmbiguous of [true, false]) {
        for (let i = 0; i < 500; i++) {
          const password = generatePassword({ symbols, avoidAmbiguous });
          const estimate = estimateStrength(password);
          expect(estimate.score, password).toBe(4);
          expect(estimate.hints, password).toEqual([]);
        }
      }
    }
    // Lower-case only is the hardest case (94 bits nominal): chance patterns must stay harmless.
    const lower = randomStrings(LOWER, 20, 5000, 2).map((password) => estimateStrength(password));
    expect(lower.filter((estimate) => estimate.score === 4).length).toBeGreaterThanOrEqual(4990);
    expect(Math.min(...lower.map((estimate) => estimate.bits))).toBeGreaterThan(70);
  });

  it('never estimates more than the brute-force entropy', () => {
    const samples = [
      ...randomStrings(ALNUM, 12, 50, 3),
      'Password123!',
      'correct horse battery staple',
      '我的密码很安全',
      'a',
    ];
    for (const password of samples) {
      const length = Array.from(password).length;
      // 26 + 26 + 10 + 33 + 100 characters is the largest pool the estimator assumes.
      expect(estimateStrength(password).bits).toBeLessThanOrEqual(length * Math.log2(195) + 0.1);
    }
  });

  it('counts code points, not UTF-16 units', () => {
    const emoji = estimateStrength('😀🎉🚀🌈');
    const cjk = estimateStrength('密码安全');
    expect(emoji.bits).toBe(cjk.bits);
    expect(emoji.hints).toContain('too-short');
  });

  it('handles non-ASCII passwords', () => {
    expect(estimateStrength('我的密码很安全').score).toBeGreaterThanOrEqual(2);
    expect(estimateStrength('пароль').score).toBeLessThanOrEqual(1);
    expect(estimateStrength('ñandú-Ωmega-北京-42').score).toBe(4);
  });

  it('stays fast and sane on very long input', () => {
    const started = performance.now();
    expect(estimateStrength('a'.repeat(100_000)).score).toBeLessThanOrEqual(1);
    expect(estimateStrength('ab'.repeat(50_000)).score).toBeLessThanOrEqual(1);
    expect(estimateStrength(randomStrings(ALNUM, 100_000, 1, 9)[0]!).score).toBe(4);
    expect(estimateStrength('password'.repeat(16)).score).toBe(0);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('returns bits rounded to one decimal', () => {
    for (const password of ['a', 'Password123!', 'hT7$kPz2', '密码']) {
      const { bits } = estimateStrength(password);
      expect(Math.round(bits * 10) / 10).toBe(bits);
      expect(bits).toBeGreaterThan(0);
    }
  });
});
