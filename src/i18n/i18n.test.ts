import { effect } from '@preact/signals';
import { afterEach, describe, expect, it } from 'vitest';
import type { AlgorithmId, EngineErrorCode, Permissions } from '../engine/types';
import { ALL_PERMISSIONS } from '../engine/types';
import type { StrengthHint, StrengthScore } from '../lib/password-strength';
import { resetSettings, updateSettings } from '../state/settings';
import { en } from './en';
import {
  DICTIONARIES,
  LOCALES,
  PERMISSION_ORDER,
  algorithmChipLabel,
  algorithmLabel,
  detectLocale,
  errorText,
  formatDuration,
  formatFiles,
  formatList,
  formatPages,
  formatPercent,
  formatSize,
  isOutdatedAlgorithm,
  locale,
  lockAlgorithmDescription,
  lockAlgorithmLabel,
  msg,
  permissionLabel,
  resolveLocale,
  restrictionList,
  strengthHintText,
  strengthLabel,
  t,
  translate,
  type ErrorCode,
  type Locale,
  type Message,
  type MessageKey,
  type MessageValue,
} from './index';
import { zhCN } from './zh-CN';

afterEach(() => {
  resetSettings();
});

const keys = Object.keys(zhCN) as MessageKey[];

function templates(value: MessageValue): string[] {
  return typeof value === 'string' ? [value] : [value.one, value.other];
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

describe('dictionaries', () => {
  it('have exactly the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    expect(keys.length).toBeGreaterThan(250);
  });

  it('have no empty or untrimmed values', () => {
    for (const target of LOCALES) {
      for (const key of keys) {
        for (const template of templates(DICTIONARIES[target][key])) {
          expect(template.trim(), `${target} ${key}`).not.toBe('');
          // The list separator is the one value that ends in a space on purpose.
          if (key !== 'list.separator') {
            expect(template, `${target} ${key}`).toBe(template.trim());
          }
        }
      }
    }
  });

  it('use the same placeholders in both languages and in every plural form', () => {
    for (const key of keys) {
      const expected = placeholders(templates(zhCN[key])[0]!);
      for (const template of templates(en[key])) {
        expect(placeholders(template), key).toEqual(expected);
      }
    }
  });

  it('keep Chinese free of plural forms, and give English ones only where a count exists', () => {
    for (const key of keys) {
      expect(typeof zhCN[key], key).toBe('string');
      if (typeof en[key] !== 'string') {
        expect(placeholders(zhCN[key]), key).toContain('count');
      }
    }
  });

  it('give every English message with a count both plural forms', () => {
    for (const key of keys) {
      if (!placeholders(zhCN[key]).includes('count')) continue;
      const value = en[key];
      expect(typeof value, key).toBe('object');
      if (typeof value === 'object') expect(value.one, key).not.toBe(value.other);
    }
  });

  it('contain no emoji, no ASCII ellipsis and no straight quotes around names', () => {
    for (const target of LOCALES) {
      for (const key of keys) {
        for (const template of templates(DICTIONARIES[target][key])) {
          expect(template, `${target} ${key}`).not.toMatch(/\p{Extended_Pictographic}/u);
          expect(template, `${target} ${key}`).not.toContain('...');
          expect(template, `${target} ${key}`).not.toMatch(/["']\{/);
        }
      }
    }
  });

  it('write Chinese with full-width punctuation and spaces around Latin words', () => {
    for (const key of keys) {
      const text = zhCN[key];
      // A half-width comma, colon, semicolon or parenthesis next to a Chinese character.
      expect(text, key).not.toMatch(/[一-鿿][,;:()!?]|[,;:()!?][一-鿿]/);
      expect(text, key).not.toMatch(/[一-鿿](?:PDF|AES|RC4|ZIP|qpdf)/);
    }
  });

  it('name the app and the languages the same way everywhere', () => {
    expect(zhCN['app.name']).toBe('PDF 钥匙');
    expect(en['app.name']).toBe('PDF Key');
    for (const target of LOCALES) {
      expect(DICTIONARIES[target]['settings.language.zh-CN']).toBe('简体中文');
      expect(DICTIONARIES[target]['settings.language.en']).toBe('English');
    }
  });

  it('use the strings of the specification', () => {
    const expected: Partial<Record<MessageKey, string>> = {
      'mode.unlock': '解锁',
      'mode.lock': '加密',
      'empty.choose': '选择 PDF',
      'empty.dropHint': '或将文件拖到这里',
      'empty.privacy': '文件只在本机处理，不会上传',
      'empty.chip.batch': '批量处理',
      'empty.chip.offline': '离线可用',
      'chip.needsPassword': '需要密码',
      'chip.restricted': '仅权限限制',
      'chip.notEncrypted': '未加密',
      'chip.unlocked': '已解锁',
      'chip.encrypted': '已加密',
      'entry.password.wrong': '密码不正确',
      'entry.currentPassword.label': '当前密码',
      'entry.save': '保存',
      'entry.share': '分享',
      'entry.open': '打开',
      'action.unlock': '解锁',
      'action.removeRestrictions': '解除限制',
      'action.lock': '加密',
      'action.saveAll': '全部保存',
      'action.shareAll': '全部分享',
      'action.clear': '清空',
      'action.startOver': '处理新文件',
      'lock.generate': '生成强密码',
      'lock.advanced': '高级选项',
      'lock.algorithm.aes-256': 'AES-256（推荐）',
      'lock.algorithm.aes-128': 'AES-128（兼容旧版阅读器）',
      'lock.owner.switch': '单独设置权限密码',
      'lock.permission.print': '打印',
      'lock.print.full': '允许',
      'lock.print.low': '仅低分辨率',
      'lock.print.none': '禁止',
      'lock.permission.extract': '复制文字和图片',
      'lock.permission.modify': '修改内容',
      'lock.permission.annotate': '批注和填写表单',
      'lock.permission.assemble': '页面整理',
      'lock.metadata.switch': '加密文档元数据',
      'settings.language.auto': '跟随系统',
      'settings.theme.system': '系统',
      'settings.theme.light': '浅色',
      'settings.theme.dark': '深色',
      'settings.autoSave': '处理完成后自动保存',
      'settings.output.optimize': '优化文件大小',
      'settings.output.linearize': '快速网页预览',
      'toast.update.action': '刷新',
      'restriction.print': '不可打印',
      'restriction.extract': '不可复制',
    };
    for (const [key, text] of Object.entries(expected)) {
      expect(zhCN[key as MessageKey], key).toBe(text);
    }
  });
});

describe('translate', () => {
  it('interpolates parameters', () => {
    expect(translate('zh-CN', 'aria.removeFile', { name: '报告.pdf' })).toBe('移除 报告.pdf');
    expect(translate('en', 'aria.removeFile', { name: 'report.pdf' })).toBe('Remove report.pdf');
  });

  it('interpolates every occurrence and leaves unknown placeholders alone', () => {
    expect(translate('en', 'format.minutes', { minutes: 1, seconds: 5 })).toBe('1 min 5 s');
    expect(translate('en', 'format.minutes', { minutes: 1 })).toBe('1 min {seconds} s');
  });

  it('does not treat parameter values as templates', () => {
    expect(translate('en', 'toast.notPdf', { name: '{name}{count}$&' })).toBe(
      '“{name}{count}$&” is not a PDF and was skipped',
    );
  });

  it('selects English plural forms by count', () => {
    expect(translate('en', 'format.files', { count: 1 })).toBe('1 file');
    expect(translate('en', 'format.files', { count: 0 })).toBe('0 files');
    expect(translate('en', 'format.files', { count: 2 })).toBe('2 files');
    expect(translate('en', 'action.unlockCount', { count: 3 })).toBe('Unlock 3 files');
    expect(translate('zh-CN', 'action.unlockCount', { count: 1 })).toBe('解锁 1 个文件');
  });

  it('formats numeric parameters for the locale', () => {
    expect(translate('en', 'format.pages', { count: 12345 })).toBe('12,345 pages');
    expect(translate('zh-CN', 'format.pages', { count: 12345 })).toBe('12,345 页');
  });

  it('falls back to the plural "other" form without a usable count', () => {
    expect(translate('en', 'format.files')).toBe('{count} files');
    expect(translate('en', 'format.files', { count: 'many' })).toBe('many files');
  });
});

describe('t', () => {
  it('follows the language setting', () => {
    updateSettings({ language: 'zh-CN' });
    expect(locale.value).toBe('zh-CN');
    expect(t('action.unlock')).toBe('解锁');
    updateSettings({ language: 'en' });
    expect(t('action.unlock')).toBe('Unlock');
  });

  it('re-runs whoever called it when the language changes', () => {
    updateSettings({ language: 'en' });
    const seen: string[] = [];
    const dispose = effect(() => {
      seen.push(t('toast.savedCount', { count: 2 }));
    });
    updateSettings({ language: 'zh-CN' });
    updateSettings({ language: 'en' });
    dispose();
    updateSettings({ language: 'zh-CN' });
    expect(seen).toEqual(['2 files saved', '已保存 2 个文件', '2 files saved']);
  });

  it('translates messages and lists carried by view models', () => {
    updateSettings({ language: 'zh-CN' });
    const single: Message = msg('toast.notPdf', { name: 'a.txt' });
    expect(single).toEqual({ key: 'toast.notPdf', params: { name: 'a.txt' } });
    expect(msg('toast.saved')).toEqual({ key: 'toast.saved' });
    expect(t(single)).toBe('“a.txt”不是 PDF，已跳过');
    const list = { list: [msg('restriction.print'), msg('restriction.extract')] };
    expect(t(list)).toBe('不可打印、不可复制');
    updateSettings({ language: 'en' });
    expect(t(list)).toBe('No printing, No copying');
    expect(t({ list: [] })).toBe('');
  });

  it('checks parameters at compile time', () => {
    updateSettings({ language: 'en' });
    // @ts-expect-error the message needs a count
    t('action.unlockCount');
    // @ts-expect-error wrong parameter name
    t('action.unlockCount', { number: 1 });
    // @ts-expect-error the message takes no parameters
    t('action.unlock', { count: 1 });
    // @ts-expect-error not a key
    t('action.doesNotExist');
    expect(t('action.unlockCount', { count: 1 })).toBe('Unlock 1 file');
  });
});

describe('language detection', () => {
  it.each<[string[], Locale]>([
    [['zh-CN'], 'zh-CN'],
    [['zh'], 'zh-CN'],
    [['zh-TW'], 'zh-CN'],
    [['zh-Hant-HK', 'en'], 'zh-CN'],
    [['ZH_cn'], 'zh-CN'],
    [['en-US', 'zh-CN'], 'en'],
    [['fr-FR', 'zh-CN', 'en'], 'zh-CN'],
    [['ja', 'en-GB'], 'en'],
    [['de'], 'en'],
    [['zha'], 'en'],
    [[], 'en'],
  ])('%j -> %s', (languages, expected) => {
    expect(detectLocale(languages)).toBe(expected);
  });

  it('copes with missing or odd input', () => {
    expect(detectLocale(undefined)).toBe('en');
    expect(detectLocale(null)).toBe('en');
    expect(detectLocale([undefined as unknown as string, 'zh'])).toBe('zh-CN');
  });

  it('only detects when the setting is "auto"', () => {
    expect(resolveLocale('auto', ['zh-CN'])).toBe('zh-CN');
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
    expect(resolveLocale('zh-CN', ['en'])).toBe('zh-CN');
  });
});

describe('formatting', () => {
  it('formats sizes', () => {
    updateSettings({ language: 'en' });
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(0)).toBe('0 B');
    updateSettings({ language: 'zh-CN' });
    expect(formatSize(5 * 1024 * 1024)).toBe('5 MB');
  });

  it('formats page and file counts', () => {
    updateSettings({ language: 'en' });
    expect([formatPages(1), formatPages(12), formatFiles(1), formatFiles(3)]).toEqual([
      '1 page',
      '12 pages',
      '1 file',
      '3 files',
    ]);
    updateSettings({ language: 'zh-CN' });
    expect([formatPages(1), formatPages(12), formatFiles(3)]).toEqual([
      '1 页',
      '12 页',
      '3 个文件',
    ]);
  });

  it('formats percentages, rounding down and clamping', () => {
    updateSettings({ language: 'en' });
    expect([0, 0.004, 0.45, 0.999, 1, 1.7, -1, Number.NaN].map(formatPercent)).toEqual([
      '0%',
      '0%',
      '45%',
      '99%',
      '100%',
      '100%',
      '0%',
      '0%',
    ]);
    expect(formatPercent(0.29)).toBe('29%');
    expect(formatPercent(0.57)).toBe('57%');
  });

  it('formats durations', () => {
    updateSettings({ language: 'en' });
    expect(
      [0, 400, 949, 950, 2449, 9949, 9950, 38_400, 59_600, 65_000, 3_725_000].map(formatDuration),
    ).toEqual([
      'Less than a second',
      'Less than a second',
      'Less than a second',
      '1.0 s',
      '2.4 s',
      '9.9 s',
      '10 s',
      '38 s',
      '1 min 0 s',
      '1 min 5 s',
      '62 min 5 s',
    ]);
    updateSettings({ language: 'zh-CN' });
    expect([400, 2400, 38_000, 65_000].map(formatDuration)).toEqual([
      '不到 1 秒',
      '2.4 秒',
      '38 秒',
      '1 分 5 秒',
    ]);
    expect(formatDuration(Number.NaN)).toBe('不到 1 秒');
  });

  it('joins lists with the separator of the language', () => {
    updateSettings({ language: 'zh-CN' });
    expect(formatList(['甲', '乙', '丙'])).toBe('甲、乙、丙');
    updateSettings({ language: 'en' });
    expect(formatList(['a', 'b'])).toBe('a, b');
  });
});

describe('labels', () => {
  // A record, so that the compiler rejects this test when a code is added to the engine.
  const errorCodes: Record<ErrorCode, true> = {
    'password-required': true,
    'password-incorrect': true,
    'not-encrypted': true,
    'not-pdf': true,
    damaged: true,
    'unsupported-encryption': true,
    'password-not-encodable': true,
    'password-too-long': true,
    'password-missing': true,
    'read-failed': true,
    'out-of-memory': true,
    cancelled: true,
    'engine-unavailable': true,
    internal: true,
    unknown: true,
  };
  const engineCodes: EngineErrorCode[] = Object.keys(errorCodes).filter(
    (code): code is EngineErrorCode => code !== 'unknown',
  );

  it('has a headline and an advice sentence for every engine error code', () => {
    expect(engineCodes).toHaveLength(14);
    for (const code of Object.keys(errorCodes) as ErrorCode[]) {
      const { title, advice } = errorText(code);
      for (const target of LOCALES) {
        const headline = translate(target, title.key);
        const sentence = translate(target, advice.key);
        expect(headline.length, `${target} ${code}`).toBeLessThanOrEqual(40);
        expect(headline, `${target} ${code}`).not.toMatch(/[.。]$/);
        expect(sentence, `${target} ${code}`).toMatch(/[.。]$/);
        expect(sentence, `${target} ${code}`).not.toBe(headline);
      }
    }
  });

  it('has a label for every strength level and hint', () => {
    const scores: Record<StrengthScore, true> = { 0: true, 1: true, 2: true, 3: true, 4: true };
    const hints: Record<StrengthHint, true> = {
      'too-short': true,
      'common-password': true,
      'repeated-characters': true,
      sequence: true,
      'single-character-class': true,
      'looks-like-date': true,
    };
    const labels = Object.keys(scores).map((score) =>
      translate('zh-CN', strengthLabel(Number(score) as StrengthScore).key),
    );
    expect(labels).toEqual(['很弱', '弱', '一般', '强', '很强']);
    for (const hint of Object.keys(hints) as StrengthHint[]) {
      expect(translate('en', strengthHintText(hint).key)).not.toBe('');
    }
  });

  it('labels every algorithm and marks RC4 as outdated', () => {
    const algorithms: Record<AlgorithmId, true> = {
      rc4: true,
      'aes-128': true,
      'aes-256-r5': true,
      'aes-256': true,
      unknown: true,
    };
    updateSettings({ language: 'zh-CN' });
    expect(t(algorithmLabel({ algorithm: 'rc4', keyBits: 40 }))).toBe('RC4 40 位（已过时）');
    expect(t(algorithmLabel({ algorithm: 'rc4', keyBits: 128 }))).toBe('RC4 128 位（已过时）');
    expect(t(algorithmLabel({ algorithm: 'aes-128', keyBits: 128 }))).toBe('AES-128');
    expect(t(algorithmLabel({ algorithm: 'aes-256', keyBits: 256 }))).toBe('AES-256');
    expect(t(algorithmChipLabel({ algorithm: 'rc4', keyBits: 128 }))).toBe('RC4-128');
    expect(t(algorithmChipLabel({ algorithm: 'aes-256-r5', keyBits: 256 }))).toBe('AES-256');
    updateSettings({ language: 'en' });
    expect(t(algorithmLabel({ algorithm: 'rc4', keyBits: 40 }))).toBe('RC4 40-bit (outdated)');
    for (const algorithm of Object.keys(algorithms) as AlgorithmId[]) {
      expect(t(algorithmLabel({ algorithm, keyBits: 128 }))).not.toBe('');
      expect(t(algorithmChipLabel({ algorithm, keyBits: 128 }))).not.toBe('');
      expect(isOutdatedAlgorithm(algorithm)).toBe(algorithm === 'rc4');
    }
    expect(t(lockAlgorithmLabel('aes-256'))).toBe('AES-256 (recommended)');
    expect(t(lockAlgorithmDescription('aes-128'))).toContain('32');
  });

  it('labels every permission, in a fixed order', () => {
    expect([...PERMISSION_ORDER].sort()).toEqual(Object.keys(ALL_PERMISSIONS).sort());
    updateSettings({ language: 'zh-CN' });
    expect(PERMISSION_ORDER.map((id) => t(permissionLabel(id)))).toEqual([
      '打印',
      '复制文字和图片',
      '修改内容',
      '批注',
      '填写表单',
      '页面整理',
      '供辅助功能读取',
    ]);
  });

  it('summarises restrictions in one line', () => {
    updateSettings({ language: 'zh-CN' });
    const restricted: Permissions = { ...ALL_PERMISSIONS, print: 'none', extract: false };
    expect(t(restrictionList(restricted))).toBe('不可打印、不可复制');
    expect(t(restrictionList({ ...ALL_PERMISSIONS, print: 'low' }))).toBe('仅可低分辨率打印');
    expect(restrictionList(ALL_PERMISSIONS).list).toEqual([]);
    expect(
      restrictionList({
        print: 'none',
        modify: false,
        extract: false,
        annotate: false,
        fillForms: false,
        assemble: false,
        accessibility: false,
      }).list,
    ).toHaveLength(6);
  });
});
