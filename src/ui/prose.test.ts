import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import type { MessageValue } from '../i18n/types';
import { zhCN } from '../i18n/zh-CN';
import { splitKept, splitLongTail, splitTail, splitTerms } from './prose';

/** Every text of a catalogue: a message with plural forms contributes each of them. */
function texts(catalogue: Record<string, MessageValue>): string[] {
  return Object.values(catalogue).flatMap((value) =>
    typeof value === 'string' ? [value] : [value.one, value.other],
  );
}

describe('splitTail: Chinese', () => {
  it('keeps the last clause together', () => {
    expect(splitTail(zhCN['lock.warning'])).toEqual([
      '请牢记密码。密码一旦遗忘就无法找回，',
      '文件也将无法打开。',
    ]);
    expect(splitTail(zhCN['error.damaged.advice'])).toEqual([
      '文件结构损坏，无法读取。',
      '请重新下载或重新导出后再试。',
    ]);
    expect(splitTail(zhCN['error.engine-unavailable.advice'])[1]).toBe(
      '首次使用需要联网加载一次。',
    );
    expect(splitTail(zhCN['about.privacy'])[1]).toBe('也不含统计或跟踪代码。');
  });

  it('keeps Latin words and numbers of the clause whole', () => {
    expect(splitTail(zhCN['lock.algorithm.aes-128.description'])[1]).toBe('最多 32 个字符');
    expect(splitTail(zhCN['details.outdated'])[1]).toBe('建议用 AES-256 重新加密。');
    expect(splitTail(zhCN['settings.autoSave.description'])[1]).toBe('多个文件会打包成一个 ZIP。');
  });

  it('keeps a remark in brackets at the end together', () => {
    expect(splitTail('RC4 40 位（已过时）')).toEqual(['RC4 40 位', '（已过时）']);
    expect(splitTail(zhCN['algorithm.aes-256-r5'])).toEqual(['AES-256', '（旧版 R5）']);
  });

  it('takes the next clause too when the last one alone is a stub', () => {
    expect(splitTail('请先检查文件，然后重试，谢谢。')).toEqual([
      '请先检查文件，',
      '然后重试，谢谢。',
    ]);
  });

  it('falls back to the last words when the last clause is long', () => {
    expect(splitTail(zhCN['about.licenses.ijg'])[1]).toMatch(/工作成果。$/);
    // Not inside "AGPL-3.0", and the opening bracket goes along.
    expect(splitTail(zhCN['about.licenses.app'])[1]).toMatch(/（AGPL-3\.0）发布。$/);
  });

  it('starts the piece with a whole word, not with the end of one', () => {
    expect(splitTail(zhCN['error.password-incorrect.advice'])[1]).toMatch(/输入法后重试。$/);
    expect(splitTail(zhCN['settings.install.hint'])[1]).toMatch(/“添加到主屏幕”。$/);
  });

  it('leaves a short text alone', () => {
    expect(splitTail('密码不正确')).toEqual(['密码不正确', '']);
    expect(splitTail('已保存')).toEqual(['已保存', '']);
    expect(splitTail('')).toEqual(['', '']);
  });
});

describe('splitLongTail', () => {
  it('keeps the last words of a long clause together', () => {
    const [clause, end] = splitLongTail('请重新下载或重新导出后再试。');
    expect(clause + end).toBe('请重新下载或重新导出后再试。');
    expect(end).toMatch(/再试。$/);
    expect(end.length).toBeGreaterThanOrEqual(5);
  });

  it('leaves a short clause and English alone', () => {
    expect(splitLongTail('也会被加密。')).toEqual(['也会被加密。', '']);
    expect(splitLongTail('（已过时）')).toEqual(['（已过时）', '']);
    expect(splitLongTail('version 3 (AGPL-3.0).')).toEqual(['version 3 (AGPL-3.0).', '']);
  });
});

describe('splitKept: how the pieces are set', () => {
  /** Near enough the width in ems: Han and full-width punctuation 1, everything else half. */
  const width = (text: string): number =>
    [...text].reduce((sum, char) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.5), 0);

  it('sets a short last clause without line breaks, and of a long one its last words', () => {
    expect(splitKept(zhCN['lock.algorithm.aes-128.description'])).toMatchObject({
      clause: '最多 32 个字符',
      end: '',
      tight: 'clause',
    });
    expect(splitKept(zhCN['lock.warning'])).toEqual({
      free: '请牢记密码。密码一旦遗忘就无法找回，',
      clause: '文件也将',
      end: '无法打开。',
      tight: 'end',
    });
    expect(splitKept('密码不正确')).toMatchObject({ clause: '', end: '', tight: null });
  });

  it('sets nothing without line breaks that a narrow column could not hold', () => {
    const pieces = texts(zhCN).map((text) => {
      const { clause, end, tight } = splitKept(text);
      return tight === 'clause' ? clause : tight === 'end' ? end : '';
    });
    expect(pieces.filter((piece) => piece !== '').length).toBeGreaterThan(40);
    for (const piece of pieces) expect(width(piece), piece).toBeLessThanOrEqual(10);
    // A long clause with nothing to split it at wraps where it has to.
    const unbroken = `前面的话，后面是一个很长很长很长很长很长的地址${'x'.repeat(40)}`;
    expect(splitKept(unbroken).tight).toBeNull();
  });

  it('changes no text', () => {
    for (const text of [...texts(zhCN), ...texts(en)]) {
      const { free, clause, end } = splitKept(text);
      expect(free + clause + end).toBe(text);
      expect(splitTerms(text).join('')).toBe(text);
    }
  });

  it('sets a clause without last words of its own as one piece, brackets and all', () => {
    // A line could break after the closing bracket: "……（AGPL-3.0） / 发布。"
    expect(splitKept(zhCN['about.licenses.app'])).toMatchObject({
      clause: '（AGPL-3.0）发布。',
      end: '',
      tight: 'clause',
    });
  });
});

describe('splitTerms: what a line must not take apart', () => {
  it('finds the terms with a hyphen or a slash in them', () => {
    // Every second part is a term.
    expect(splitTerms('建议用\u00a0AES-256\u00a0')).toEqual(['建议用\u00a0', 'AES-256', '\u00a0']);
    expect(splitTerms('（AGPL-3.0）发布。')).toEqual(['（', 'AGPL-3.0', '）发布。']);
    expect(splitTerms('AES-128 或 RC4-40，见 a/b.pdf')).toEqual([
      '',
      'AES-128',
      ' 或 ',
      'RC4-40',
      '，见 ',
      'a/b.pdf',
      '',
    ]);
  });

  it('leaves other text alone', () => {
    expect(splitTerms('最多 32 个字符')).toEqual(['最多 32 个字符']);
    expect(splitTerms('3.0 版 - 说明')).toEqual(['3.0 版 - 说明']);
    expect(splitTerms('')).toEqual(['']);
  });

  it('does not keep together what no column could hold', () => {
    const name = `${'report-'.repeat(8)}final.pdf`;
    expect(splitTerms(`已保存 ${name}`)).toEqual([`已保存 ${name}`]);
  });

  it('is at work in the clauses that are not set without line breaks as a whole', () => {
    const { clause, tight } = splitKept(zhCN['details.outdated']);
    expect(tight).toBe('end');
    expect(splitTerms(clause)).toContain('AES-256');
  });
});

describe('splitTail: English', () => {
  it('keeps the last two words together', () => {
    expect(splitTail(en['lock.warning'] as string)[1]).toBe('be opened.');
    expect(splitTail(en['error.damaged.advice'] as string)[1]).toBe('then retry.');
  });

  it('keeps a number with the word in front of it', () => {
    expect(splitTail(en['about.licenses.app'] as string)[1]).toBe('version 3 (AGPL-3.0).');
  });

  it('leaves a text of a few words alone', () => {
    expect(splitTail('RC4 40-bit (outdated)')).toEqual(['RC4 40-bit (outdated)', '']);
    expect(splitTail('Wrong password')).toEqual(['Wrong password', '']);
  });

  it('does not glue two long words', () => {
    const text = 'This needs an extraordinarily incomprehensible';
    expect(splitTail(text)).toEqual([text, '']);
  });
});

describe('splitTail: every message of the app', () => {
  it.each([
    ['zh-CN', texts(zhCN)],
    ['en', texts(en)],
  ])('%s: nothing is lost and no tail is a stub', (_, all) => {
    for (const text of all) {
      const [head, tail] = splitTail(text);
      expect(head + tail).toBe(text);
      if (!tail) continue;
      expect(head).not.toBe('');
      expect(head.endsWith(' ') || !/^\s/.test(tail)).toBe(true);
      // More than "打开。" or one short word.
      expect(tail.replace(/[\s，。；：！？、,.;:!?…]/g, '').length).toBeGreaterThanOrEqual(4);
    }
  });
});
