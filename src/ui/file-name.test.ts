import { describe, expect, it } from 'vitest';
import { truncateMiddle } from './file-name';

/** A fixed-pitch "font": CJK characters are two units wide, everything else one. */
function width(text: string): number {
  let total = 0;
  for (const char of text) total += /[⺀-鿿]/.test(char) ? 2 : 1;
  return total;
}

describe('truncateMiddle', () => {
  it('leaves a name that fits alone', () => {
    expect(truncateMiddle('report.pdf', 10, width)).toBe('report.pdf');
    expect(truncateMiddle('report.pdf', 100, width)).toBe('report.pdf');
  });

  it('cuts in the middle and keeps the end of the name with its extension', () => {
    const name = '2024年度财务报表_最终版(3).pdf';
    expect(width(name)).toBe(30);
    const short = truncateMiddle(name, 26, width);
    expect(short).toBe('2024年度…表_最终版(3).pdf');
    expect(width(short)).toBeLessThanOrEqual(26);
  });

  it('uses the room it is given: one more character would not fit', () => {
    const name = 'a-very-long-file-name-that-goes-on-and-on_unlocked.pdf';
    const short = truncateMiddle(name, 32, width);
    expect(short).toBe('a-very-long-file-n…_unlocked.pdf');
    expect(width(short)).toBe(32);
  });

  it('keeps the suffix of an output name readable', () => {
    const short = truncateMiddle('2024年度财务报表_最终版(3)_unlocked.pdf', 34, width);
    expect(short.endsWith('_unlocked.pdf')).toBe(true);
    expect(width(short)).toBeLessThanOrEqual(34);
  });

  it('never splits a surrogate pair', () => {
    const name = `${'𠮷'.repeat(20)}.pdf`;
    const short = truncateMiddle(name, 16, width);
    expect(short.isWellFormed()).toBe(true);
    expect(short.endsWith('.pdf')).toBe(true);
  });

  it('gives up the tail before the head when there is very little room', () => {
    const short = truncateMiddle('quarterly-report-final-version.pdf', 12, width);
    expect(short).toContain('…');
    expect(short.endsWith('.pdf')).toBe(true);
    expect(width(short)).toBeLessThanOrEqual(12);
  });

  it('handles names without an extension and a width of nothing', () => {
    const short = truncateMiddle('a'.repeat(50), 20, width);
    expect(width(short)).toBeLessThanOrEqual(20);
    expect(short).toContain('…');
    // Not laid out yet: nothing to measure against, so nothing is cut.
    expect(truncateMiddle('report.pdf', 0, width)).toBe('report.pdf');
  });
});
