import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  checkNewPasswords,
  encodeNewPasswords,
  encodePdfDoc,
  maxPasswordBytes,
  openCandidates,
  sameNewPassword,
  toHex,
} from './passwords';
import { saslprep } from './saslprep';
import { PdfEngineError } from './types';

const hex = (bytes: Uint8Array): string => toHex(bytes);
const utf8Hex = (text: string): string => hex(new TextEncoder().encode(text));
const candidateHex = (password: string, revision: number): string[] =>
  openCandidates(password, revision).map(hex);

/** Builds a string from code points, so the source stays free of invisible characters. */
const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

describe('saslprep', () => {
  test('RFC 4013 section 3 examples', () => {
    // 1: soft hyphen mapped to nothing
    expect(saslprep(`I${cp(0xad)}X`)).toEqual({ value: 'IX', failure: null });
    // 2: no transformation
    expect(saslprep('user')).toEqual({ value: 'user', failure: null });
    // 3: case preserved
    expect(saslprep('USER')).toEqual({ value: 'USER', failure: null });
    // 4: output is NFKC, input in ISO 8859-1
    expect(saslprep(cp(0xaa))).toEqual({ value: 'a', failure: null });
    // 5: output is NFKC, matches #1
    expect(saslprep(cp(0x2168))).toEqual({ value: 'IX', failure: null });
    // 6: prohibited character
    expect(saslprep(cp(0x07)).failure).toBe('prohibited');
    // 7: bidirectional check
    expect(saslprep(cp(0x627, 0x31)).failure).toBe('bidi');
  });

  test('agrees with the RFC 3454 tables of the Python standard library', () => {
    const vectors = JSON.parse(
      readFileSync(new URL('../../tests/fixtures/saslprep-vectors.json', import.meta.url), 'utf8'),
    ) as [string, string, string | null][];
    expect(vectors.length).toBeGreaterThan(250);
    for (const [input, output, failure] of vectors) {
      expect(saslprep(input), JSON.stringify(input)).toEqual({ value: output, failure });
    }
  });

  test('zero width space: both interpretations are candidates', () => {
    const typed = `a${cp(0x200b)}b${cp(0xe9)}`;
    expect(saslprep(typed).value).toBe(`a b${cp(0xe9)}`);
    const candidates = openCandidates(typed, 6).map(hex);
    expect(candidates).toContain(utf8Hex(`a b${cp(0xe9)}`));
    expect(candidates).toContain(utf8Hex(`ab${cp(0xe9)}`));
  });

  test('non-ASCII spaces become a plain space', () => {
    expect(saslprep(`a${cp(0xa0)}b${cp(0x3000)}c${cp(0x2003)}d`).value).toBe('a b c d');
  });

  test('lone surrogates and non-characters are prohibited', () => {
    expect(saslprep(`a${String.fromCharCode(0xd800)}b`).failure).toBe('prohibited');
    expect(saslprep(cp(0xfffe)).failure).toBe('prohibited');
    expect(saslprep(cp(0xe000)).failure).toBe('prohibited');
  });

  test('characters newer than Unicode 3.2 are allowed', () => {
    const emoji = cp(0x1f512);
    expect(saslprep(`pass${emoji}`)).toEqual({ value: `pass${emoji}`, failure: null });
  });

  test('right-to-left only passwords pass, mixed ones fail the bidi rule', () => {
    const hebrew = cp(0x5d0, 0x5d1, 0x5d2);
    expect(saslprep(hebrew).failure).toBeNull();
    expect(saslprep(`${hebrew}abc`).failure).toBe('bidi');
    expect(saslprep(`${cp(0x5d0)}1${cp(0x5d1)}`).failure).toBeNull();
  });
});

describe('PDFDocEncoding', () => {
  test('ASCII and Latin-1 map to themselves', () => {
    expect(hex(encodePdfDoc('Az09 ~')!)).toBe('417a3039207e');
    expect(hex(encodePdfDoc(cp(0xe4, 0xf6, 0xfc, 0xff))!)).toBe('e4f6fcff');
  });

  test('the special rows', () => {
    // euro, bullet, per mille, trade mark, fi ligature, breve
    expect(hex(encodePdfDoc(cp(0x20ac, 0x2022, 0x2030, 0x2122, 0xfb01, 0x2d8))!)).toBe(
      'a0808b929318',
    );
  });

  test('characters outside the encoding', () => {
    expect(encodePdfDoc(cp(0x4e2d))).toBeNull();
    expect(encodePdfDoc(cp(0xa0))).toBeNull(); // no-break space: 0xA0 is the euro sign
    expect(encodePdfDoc(cp(0xad))).toBeNull(); // soft hyphen is undefined
    expect(encodePdfDoc(cp(0x7f))).toBeNull();
    expect(encodePdfDoc(cp(0x18))).toBeNull(); // byte 0x18 means breve
  });
});

describe('openCandidates', () => {
  test('an empty password has no candidates', () => {
    expect(openCandidates('', 6)).toEqual([]);
    expect(openCandidates('', 3)).toEqual([]);
  });

  test('an ASCII password has exactly one candidate in every revision', () => {
    for (const revision of [2, 3, 4, 5, 6]) {
      expect(candidateHex('correct horse', revision)).toEqual([utf8Hex('correct horse')]);
    }
    // Control characters are still ASCII.
    expect(candidateHex('a\tb', 4)).toEqual(['610962']);
    expect(candidateHex('a\tb', 6)).toEqual(['610962']);
  });

  test('length limits: 32 bytes up to R4, 127 from R5', () => {
    expect(maxPasswordBytes(4)).toBe(32);
    expect(maxPasswordBytes(5)).toBe(127);
    const long = 'x'.repeat(200);
    expect(openCandidates(long, 4)).toHaveLength(1);
    expect(openCandidates(long, 4)[0]).toHaveLength(32);
    expect(openCandidates(long, 6)[0]).toHaveLength(127);
    // Passwords that only differ past the limit are the same candidate.
    expect(candidateHex(`${'x'.repeat(32)}tail`, 3)).toEqual(candidateHex('x'.repeat(32), 3));
  });

  test('R6: SASLprep first, then the raw and normalised UTF-8 forms', () => {
    const typed = `${cp(0xff30, 0xff41, 0xff53, 0xff53)}${cp(0xad)}word`; // full-width "Pass", soft hyphen
    const candidates = candidateHex(typed, 6);
    expect(candidates[0]).toBe(utf8Hex('Password'));
    expect(candidates[1]).toBe(utf8Hex(typed));
    expect(candidates).toContain(utf8Hex(typed.normalize('NFKC')));
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  test('R6: composed and decomposed forms are both tried', () => {
    const composed = `p${cp(0xe4)}ss`;
    const decomposed = `pa${cp(0x308)}ss`;
    expect(candidateHex(composed, 6)).toContain(utf8Hex(decomposed));
    expect(candidateHex(decomposed, 6)).toContain(utf8Hex(composed));
    expect(candidateHex(decomposed, 6)[0]).toBe(utf8Hex(composed)); // SASLprep composes
  });

  test('R4: PDFDocEncoding first, then Windows-1252, Latin-1 and UTF-8', () => {
    const euro = `p${cp(0x20ac)}ss`;
    const candidates = candidateHex(euro, 4);
    expect(candidates[0]).toBe('70a07373'); // PDFDocEncoding
    expect(candidates[1]).toBe('70807373'); // Windows-1252
    expect(candidates).toContain(utf8Hex(euro));
    expect(candidates.indexOf('70a07373')).toBeLessThan(candidates.indexOf(utf8Hex(euro)));

    const umlaut = `P${cp(0xe4)}ssw${cp(0xf6)}rd`;
    expect(candidateHex(umlaut, 3)[0]).toBe('50e4737377f67264');
    expect(candidateHex(umlaut, 3)).toContain(utf8Hex(umlaut));
  });

  test('R3: legacy CJK encodings', () => {
    const chinese = cp(0x4e2d, 0x6587, 0x5bc6, 0x7801);
    const candidates = candidateHex(chinese, 3);
    expect(candidates).toContain('d6d0cec4c3dcc2eb'); // GBK
    expect(candidates).toContain(utf8Hex(chinese));
    // Big5 has no simplified characters: no Big5 candidate for this password, one for the
    // traditional spelling.
    expect(candidateHex(cp(0x5bc6, 0x78bc), 3)).toContain('b14bbd58');

    const japanese = cp(0x30d1, 0x30b9, 0x79d8, 0x5bc6);
    const jp = candidateHex(japanese, 4);
    expect(jp).toContain('8370835894e996a7'); // Shift_JIS
    expect(jp).toContain('a5d1a5b9c8ebcca9'); // EUC-JP

    const korean = cp(0xbe44, 0xbc00);
    expect(candidateHex(korean, 3)).toContain('baf1b9d0'); // EUC-KR
  });

  test('Big5 prefers the canonical sequence for duplicated characters', () => {
    // U+5341 exists at A2CC (a numeral form) and A451; encoders produce A451.
    expect(candidateHex(cp(0x5341), 3)).toContain('a451');
    expect(candidateHex(cp(0x5341), 3)).not.toContain('a2cc');
  });

  test('legacy single-byte code pages', () => {
    const russian = cp(0x43f, 0x430, 0x440, 0x43e, 0x43b, 0x44c);
    const candidates = candidateHex(russian, 3);
    expect(candidates).toContain('efe0f0eeebfc'); // Windows-1251
    expect(candidates).toContain('d0c1d2cfccd8'); // KOI8-R
  });

  test('legacy encodings are also offered for R6, after the Unicode forms', () => {
    const chinese = cp(0x5bc6, 0x7801);
    const candidates = candidateHex(chinese, 6);
    expect(candidates[0]).toBe(utf8Hex(chinese));
    expect(candidates).toContain('c3dcc2eb');
  });

  test('candidates never contain a zero byte and are unique', () => {
    for (const password of [
      `a${cp(0)}b${cp(0xe9)}`,
      cp(0x4e2d, 0x6587),
      `${cp(0xe9)}${cp(0x20ac)}`,
    ]) {
      for (const revision of [3, 6]) {
        const candidates = openCandidates(password, revision);
        expect(candidates.every((c) => !c.includes(0) && c.length > 0)).toBe(true);
        expect(new Set(candidates.map(hex)).size).toBe(candidates.length);
      }
    }
  });
});

describe('new passwords', () => {
  const permissive = { userPassword: '', ownerPassword: '' };

  test('AES-256: SASLprep, then UTF-8', () => {
    const typed = `${cp(0xff21, 0xff22)}${cp(0xad)}c${cp(0x3000)}${cp(0x5bc6)}`;
    const { user, owner } = encodeNewPasswords({
      algorithm: 'aes-256',
      userPassword: typed,
      ownerPassword: 'owner',
    });
    expect(hex(user)).toBe(utf8Hex(`ABc ${cp(0x5bc6)}`));
    expect(hex(owner)).toBe(utf8Hex('owner'));
  });

  test('AES-128: PDFDocEncoding', () => {
    const { user } = encodeNewPasswords({
      algorithm: 'aes-128',
      userPassword: `p${cp(0x20ac)}${cp(0xe4)}`,
      ownerPassword: 'o',
    });
    expect(hex(user)).toBe('70a0e4');
  });

  test('an empty owner password means "same as the user password"', () => {
    const { user, owner } = encodeNewPasswords({
      algorithm: 'aes-256',
      userPassword: 'secret',
      ownerPassword: '',
    });
    expect(hex(owner)).toBe(hex(user));
  });

  test('an empty user password is allowed with an owner password', () => {
    const { user, owner } = encodeNewPasswords({
      algorithm: 'aes-128',
      userPassword: '',
      ownerPassword: 'owner',
    });
    expect(user).toHaveLength(0);
    expect(hex(owner)).toBe(utf8Hex('owner'));
  });

  const problems: [string, Parameters<typeof checkNewPasswords>[0], string][] = [
    ['both empty', { algorithm: 'aes-256', ...permissive }, 'password-missing'],
    ['both empty (AES-128)', { algorithm: 'aes-128', ...permissive }, 'password-missing'],
    [
      '128 bytes for AES-256',
      { algorithm: 'aes-256', userPassword: 'x'.repeat(128), ownerPassword: '' },
      'password-too-long',
    ],
    [
      '43 CJK characters for AES-256 (129 bytes)',
      { algorithm: 'aes-256', userPassword: cp(0x5bc6).repeat(43), ownerPassword: '' },
      'password-too-long',
    ],
    [
      '33 bytes for AES-128',
      { algorithm: 'aes-128', userPassword: 'x'.repeat(33), ownerPassword: '' },
      'password-too-long',
    ],
    [
      'a long owner password',
      { algorithm: 'aes-128', userPassword: 'ok', ownerPassword: 'y'.repeat(40) },
      'password-too-long',
    ],
    [
      'CJK for AES-128',
      { algorithm: 'aes-128', userPassword: cp(0x5bc6, 0x7801), ownerPassword: '' },
      'password-not-encodable',
    ],
    [
      'a control character for AES-256',
      { algorithm: 'aes-256', userPassword: `bell${cp(7)}`, ownerPassword: '' },
      'password-not-encodable',
    ],
    [
      'a password SASLprep reduces to nothing',
      { algorithm: 'aes-256', userPassword: cp(0xad), ownerPassword: 'owner' },
      'password-not-encodable',
    ],
    [
      'a zero character',
      { algorithm: 'aes-128', userPassword: `a${cp(0)}b`, ownerPassword: '' },
      'password-not-encodable',
    ],
  ];

  test.each(problems)('%s -> %s', (_name, input, code) => {
    expect(checkNewPasswords(input)).toBe(code);
    expect(() => encodeNewPasswords(input)).toThrowError(PdfEngineError);
    try {
      encodeNewPasswords(input);
    } catch (error) {
      expect((error as PdfEngineError).code).toBe(code);
    }
  });

  test('limits are inclusive', () => {
    expect(
      checkNewPasswords({ algorithm: 'aes-256', userPassword: 'x'.repeat(127), ownerPassword: '' }),
    ).toBeNull();
    expect(
      checkNewPasswords({ algorithm: 'aes-128', userPassword: 'x'.repeat(32), ownerPassword: '' }),
    ).toBeNull();
  });

  test('a mixed-direction password is accepted for AES-256', () => {
    const mixed = `abc${cp(0x5d0, 0x5d1)}`;
    expect(saslprep(mixed).failure).toBe('bidi');
    expect(
      checkNewPasswords({ algorithm: 'aes-256', userPassword: mixed, ownerPassword: '' }),
    ).toBeNull();
  });
});

describe('sameNewPassword', () => {
  // "abc123" in full-width letters and digits.
  const fullWidth = cp(0xff41, 0xff42, 0xff43, 0xff11, 0xff12, 0xff13);
  const composed = `caf${cp(0xe9)}`;
  const decomposed = `cafe${cp(0x301)}`;

  test('equal text is the same password', () => {
    expect(sameNewPassword('secret', 'secret', 'aes-256')).toBe(true);
    expect(sameNewPassword('secret', 'secret', 'aes-128')).toBe(true);
    expect(sameNewPassword('', '', 'aes-256')).toBe(true);
  });

  test('different text is not, including case and spaces', () => {
    for (const algorithm of ['aes-256', 'aes-128'] as const) {
      expect(sameNewPassword('secret', 'Secret', algorithm)).toBe(false);
      expect(sameNewPassword('secret', 'secret ', algorithm)).toBe(false);
      expect(sameNewPassword('secret', '', algorithm)).toBe(false);
    }
  });

  test('AES-256: text that SASLprep maps to the same bytes', () => {
    expect(sameNewPassword('abc123', fullWidth, 'aes-256')).toBe(true);
    expect(sameNewPassword(composed, decomposed, 'aes-256')).toBe(true);
    // A soft hyphen is mapped to nothing, an ideographic space to a space.
    expect(sameNewPassword('pass word', `pa${cp(0xad)}ss${cp(0x3000)}word`, 'aes-256')).toBe(true);
    expect(
      encodeNewPasswords({ algorithm: 'aes-256', userPassword: fullWidth, ownerPassword: '' }).user,
    ).toEqual(
      encodeNewPasswords({ algorithm: 'aes-256', userPassword: 'abc123', ownerPassword: '' }).user,
    );
  });

  test('AES-128: composed and decomposed accents', () => {
    expect(sameNewPassword(composed, decomposed, 'aes-128')).toBe(true);
    expect(sameNewPassword(composed, 'cafe', 'aes-128')).toBe(false);
  });

  test('passwords that cannot be written are compared as typed', () => {
    // Full-width letters have no PDFDocEncoding: no bytes to compare.
    expect(sameNewPassword('abc123', fullWidth, 'aes-128')).toBe(false);
    expect(sameNewPassword(fullWidth, fullWidth, 'aes-128')).toBe(true);
    expect(sameNewPassword('x'.repeat(128), `${'x'.repeat(127)}y`, 'aes-256')).toBe(false);
  });
});
