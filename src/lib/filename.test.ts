import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NAMING,
  MAX_NAME_BYTES,
  firstFreeName,
  formatBytes,
  outputFileName,
  sanitizeFileName,
  splitExtension,
  uniqueNames,
} from './filename';

const bytes = (text: string): number => new TextEncoder().encode(text).length;

describe('sanitizeFileName', () => {
  it('keeps ordinary names untouched', () => {
    for (const name of ['report.pdf', 'Annual Report (final) v2.pdf', 'a-b_c+d,e;f=g.pdf']) {
      expect(sanitizeFileName(name)).toBe(name);
    }
  });

  it('preserves Unicode names', () => {
    expect(sanitizeFileName('报告 2024（最终版）.pdf')).toBe('报告 2024（最终版）.pdf');
    expect(sanitizeFileName('見積書_令和6年.pdf')).toBe('見積書_令和6年.pdf');
    expect(sanitizeFileName('Отчёт за год.pdf')).toBe('Отчёт за год.pdf');
    expect(sanitizeFileName('family 👨‍👩‍👧.pdf')).toBe('family 👨‍👩‍👧.pdf');
  });

  it('normalises to NFC', () => {
    expect(sanitizeFileName('résumé.pdf')).toBe('résumé.pdf');
  });

  it('replaces characters that are illegal on Windows', () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j.pdf')).toBe('a_b_c_d_e_f_g_h_i_j.pdf');
  });

  it('removes control, zero-width and bidirectional override characters', () => {
    expect(sanitizeFileName('a\u0000b\u0007c\u007f\u0085d.pdf')).toBe('abcd.pdf');
    expect(sanitizeFileName('tab\there\nand\r\nthere.pdf')).toBe('tab here and there.pdf');
    expect(sanitizeFileName('﻿bom​.pdf')).toBe('bom.pdf');
    // U+202E would display "invoice‮fdp.exe" as "invoiceexe.pdf".
    expect(sanitizeFileName('invoice‮fdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeFileName('a⁦b⁩.pdf')).toBe('ab.pdf');
  });

  it('removes lone surrogates but keeps valid pairs', () => {
    expect(sanitizeFileName('a\ud83db.pdf')).toBe('ab.pdf');
    expect(sanitizeFileName('a\udc00b.pdf')).toBe('ab.pdf');
    expect(sanitizeFileName('a😀b.pdf')).toBe('a😀b.pdf');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizeFileName('   spaced    out   .pdf  ')).toBe('spaced out.pdf');
    expect(sanitizeFileName('ideographic　space.pdf')).toBe('ideographic space.pdf');
  });

  it('removes trailing dots and spaces', () => {
    expect(sanitizeFileName('name. . .')).toBe('name');
    expect(sanitizeFileName('trailing dots... .pdf. . ')).toBe('trailing dots.pdf');
    expect(sanitizeFileName('base .pdf')).toBe('base.pdf');
  });

  it('removes leading dots so that files are not hidden', () => {
    expect(sanitizeFileName('.hidden report.pdf')).toBe('hidden report.pdf');
    expect(sanitizeFileName('..\\..\\evil.pdf')).toBe('_.._evil.pdf');
    expect(sanitizeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
  });

  it('gives a bare extension a base name', () => {
    expect(sanitizeFileName('.pdf')).toBe('document.pdf');
    expect(sanitizeFileName('...pdf')).toBe('document.pdf');
  });

  it('never returns an empty name', () => {
    for (const name of ['', ' ', '.', '..', '...', ' . ', '\u0000', '‮']) {
      expect(sanitizeFileName(name)).toBe('document');
    }
    expect(sanitizeFileName('???')).toBe('___');
  });

  it('escapes Windows device names, with any extension and in any case', () => {
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('nul.pdf')).toBe('_nul.pdf');
    expect(sanitizeFileName('Aux.tar.gz')).toBe('_Aux.tar.gz');
    expect(sanitizeFileName('com1.pdf')).toBe('_com1.pdf');
    expect(sanitizeFileName('LPT9')).toBe('_LPT9');
    expect(sanitizeFileName('COM¹.pdf')).toBe('_COM¹.pdf');
    expect(sanitizeFileName('prn .pdf')).toBe('_prn.pdf');
  });

  it('leaves names alone that merely start with a device name', () => {
    for (const name of ['console.pdf', 'null.pdf', 'com10.pdf', 'auxiliary.pdf', 'lpt.pdf']) {
      expect(sanitizeFileName(name)).toBe(name);
    }
  });

  it('caps the length in UTF-8 bytes and keeps the extension', () => {
    const ascii = sanitizeFileName(`${'a'.repeat(400)}.pdf`);
    expect(bytes(ascii)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(ascii.endsWith('.pdf')).toBe(true);
    expect(ascii.length).toBeGreaterThan(200);

    const cjk = sanitizeFileName(`${'报'.repeat(300)}.pdf`);
    expect(bytes(cjk)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(cjk.endsWith('.pdf')).toBe(true);
    expect(/^报+\.pdf$/u.test(cjk)).toBe(true);
  });

  it('never cuts a surrogate pair in half', () => {
    const name = sanitizeFileName(`${'😀'.repeat(200)}.pdf`);
    expect(bytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(/^(?:😀)+\.pdf$/u.test(name)).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(name)).toBe(false);
  });

  it('caps names without an extension and absurdly long extensions', () => {
    expect(bytes(sanitizeFileName('x'.repeat(1000)))).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(bytes(sanitizeFileName(`x.${'e'.repeat(1000)}`))).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });

  it('is idempotent', () => {
    const samples = [
      'a<b>c.pdf',
      ' .x. ',
      'NUL.pdf',
      `${'报'.repeat(300)}.pdf`,
      '..\\..\\evil.pdf',
      'trailing. . .pdf. .',
      '.pdf',
      `${'😀'.repeat(200)}`,
    ];
    for (const sample of samples) {
      const once = sanitizeFileName(sample);
      expect(sanitizeFileName(once)).toBe(once);
    }
  });
});

describe('splitExtension', () => {
  it('splits at the last dot', () => {
    expect(splitExtension('a.b.pdf')).toEqual({ base: 'a.b', ext: '.pdf' });
    expect(splitExtension('noext')).toEqual({ base: 'noext', ext: '' });
    expect(splitExtension('.hidden')).toEqual({ base: '.hidden', ext: '' });
    expect(splitExtension('trailing.')).toEqual({ base: 'trailing.', ext: '' });
    expect(splitExtension('Mr. Smith')).toEqual({ base: 'Mr. Smith', ext: '' });
  });
});

describe('outputFileName', () => {
  it('appends the suffix for the operation', () => {
    expect(outputFileName('report.pdf', 'decrypt')).toBe('report_unlocked.pdf');
    expect(outputFileName('report.pdf', 'encrypt')).toBe('report_locked.pdf');
    expect(outputFileName('report.pdf', 'decrypt', DEFAULT_NAMING)).toBe('report_unlocked.pdf');
  });

  it('always ends in .pdf', () => {
    expect(outputFileName('REPORT.PDF', 'decrypt')).toBe('REPORT_unlocked.pdf');
    expect(outputFileName('report', 'decrypt')).toBe('report_unlocked.pdf');
    expect(outputFileName('scan.jpeg', 'encrypt')).toBe('scan.jpeg_locked.pdf');
    expect(outputFileName('', 'decrypt')).toBe('document_unlocked.pdf');
    expect(outputFileName('.pdf', 'decrypt')).toBe('document_unlocked.pdf');
    expect(outputFileName('report.pdf. ', 'decrypt')).toBe('report_unlocked.pdf');
  });

  it('swaps suffixes instead of stacking them', () => {
    expect(outputFileName('report_locked.pdf', 'decrypt')).toBe('report_unlocked.pdf');
    expect(outputFileName('report_unlocked.pdf', 'encrypt')).toBe('report_locked.pdf');
    expect(outputFileName('report_unlocked.pdf', 'decrypt')).toBe('report_unlocked.pdf');
    expect(outputFileName('report_LOCKED.pdf', 'decrypt')).toBe('report_unlocked.pdf');
    // A name that consists of nothing but the suffix keeps it.
    expect(outputFileName('_locked.pdf', 'decrypt')).toBe('_locked_unlocked.pdf');
  });

  it('supports custom and empty suffixes', () => {
    const naming = { decryptSuffix: '', encryptSuffix: ' (已加密)' };
    expect(outputFileName('合同.pdf', 'encrypt', naming)).toBe('合同 (已加密).pdf');
    expect(outputFileName('合同 (已加密).pdf', 'decrypt', naming)).toBe('合同.pdf');
    expect(outputFileName('合同.pdf', 'decrypt', naming)).toBe('合同.pdf');
  });

  it('sanitises the input name and the suffix', () => {
    expect(outputFileName('a/b:c.pdf', 'decrypt')).toBe('a_b_c_unlocked.pdf');
    expect(
      outputFileName('x.pdf', 'encrypt', { decryptSuffix: '', encryptSuffix: '/..\\evil:' }),
    ).toBe('x_.._evil_.pdf');
    expect(outputFileName('nul.pdf', 'decrypt', { decryptSuffix: '', encryptSuffix: '' })).toBe(
      '_nul.pdf',
    );
    expect(outputFileName('nul.pdf', 'decrypt')).toBe('nul_unlocked.pdf');
  });

  it('shortens the base, never the suffix or extension', () => {
    const name = outputFileName(`${'报'.repeat(300)}.pdf`, 'decrypt');
    expect(bytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(name.endsWith('_unlocked.pdf')).toBe(true);
    expect(sanitizeFileName(name)).toBe(name);
  });

  it('survives an absurdly long suffix', () => {
    const name = outputFileName('report.pdf', 'encrypt', {
      decryptSuffix: '',
      encryptSuffix: '_'.repeat(1000),
    });
    expect(bytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(name.endsWith('.pdf')).toBe(true);
    expect(name.startsWith('report')).toBe(true);
  });
});

describe('uniqueNames', () => {
  it('returns unique lists unchanged', () => {
    const names = ['a.pdf', 'b.pdf', 'a (2).pdf'];
    expect(uniqueNames(names)).toEqual(names);
  });

  it('numbers duplicates before the extension', () => {
    expect(uniqueNames(['a.pdf', 'a.pdf', 'a.pdf'])).toEqual(['a.pdf', 'a (2).pdf', 'a (3).pdf']);
    expect(uniqueNames(['a', 'a'])).toEqual(['a', 'a (2)']);
  });

  it('compares case-insensitively and ignores Unicode normalisation', () => {
    expect(uniqueNames(['Report.pdf', 'report.PDF'])).toEqual(['Report.pdf', 'report (2).PDF']);
    expect(uniqueNames(['é.pdf', 'é.pdf'])).toEqual(['é.pdf', 'é (2).pdf']);
  });

  it('does not collide with names that are already numbered', () => {
    const result = uniqueNames(['a.pdf', 'a.pdf', 'a (2).pdf', 'a.pdf', 'a (2).pdf']);
    expect(result).toEqual(['a.pdf', 'a (3).pdf', 'a (2).pdf', 'a (4).pdf', 'a (2) (2).pdf']);
    expect(new Set(result.map((name) => name.toLowerCase())).size).toBe(result.length);
  });

  it('keeps long names within the length cap', () => {
    const long = sanitizeFileName(`${'a'.repeat(400)}.pdf`);
    const result = uniqueNames([long, long, long]);
    expect(new Set(result).size).toBe(3);
    for (const name of result) {
      expect(bytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
      expect(name.endsWith('.pdf')).toBe(true);
    }
  });

  it('handles many duplicates', () => {
    const result = uniqueNames(Array.from({ length: 500 }, () => 'x.pdf'));
    expect(new Set(result).size).toBe(500);
    expect(result[499]).toBe('x (500).pdf');
  });
});

describe('firstFreeName', () => {
  it('returns the name itself when it is free', async () => {
    expect(await firstFreeName('a.pdf', () => false)).toBe('a.pdf');
  });

  it('counts up until a free name is found', async () => {
    const taken = new Set(['a.pdf', 'a (2).pdf', 'a (3).pdf']);
    expect(await firstFreeName('a.pdf', async (name) => taken.has(name))).toBe('a (4).pdf');
  });
});

describe('formatBytes', () => {
  it('uses binary units with three significant digits', () => {
    const cases: [number, string][] = [
      [0, '0 B'],
      [1, '1 B'],
      [1023, '1023 B'],
      [1024, '1 KB'],
      [1536, '1.5 KB'],
      [10 * 1024, '10 KB'],
      [1024 * 1024, '1 MB'],
      [1_234_567, '1.18 MB'],
      [12_345_678, '11.8 MB'],
      [123_456_789, '118 MB'],
      [1024 ** 3, '1 GB'],
      [5 * 1024 ** 4, '5 TB'],
    ];
    for (const [value, expected] of cases) expect(formatBytes(value, 'en')).toBe(expected);
  });

  it('moves to the next unit instead of showing 1024', () => {
    expect(formatBytes(1024 * 1024 - 1, 'en')).toBe('1 MB');
    expect(formatBytes(1023.99 * 1024 * 1024, 'en')).toBe('1 GB');
  });

  it('uses the decimal separator of the locale', () => {
    expect(formatBytes(1536, 'de')).toBe('1,5 KB');
    expect(formatBytes(1536, 'fr')).toBe('1,5 KB');
    expect(formatBytes(1536, 'zh-CN')).toBe('1.5 KB');
  });

  it('falls back to the default locale for an invalid language tag', () => {
    expect(formatBytes(2048, 'zh_CN')).toBe(formatBytes(2048));
    expect(formatBytes(2048, 'not a locale')).toMatch(/^2 KB$/);
  });

  it('treats invalid input as zero', () => {
    for (const value of [-1, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(formatBytes(value, 'en')).toBe('0 B');
    }
  });
});
