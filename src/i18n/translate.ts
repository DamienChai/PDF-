/**
 * The translator. `t()` reads the locale signal, so a component (or `computed`/`effect`) that
 * calls it is re-run when the language changes.
 */
import { locale } from '../state/settings';
import { en } from './en';
import type { Locale } from './locale';
import type { MessageParams, MessageValue } from './types';
import { zhCN } from './zh-CN';

export type MessageKey = keyof typeof zhCN;

type PlaceholderNames<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PlaceholderNames<Rest>
  : never;

/** Names of the `{placeholders}` of a message, taken from the Chinese template. */
export type ParamNames<K extends MessageKey> = PlaceholderNames<(typeof zhCN)[K]>;

/** The parameter object a message needs; no argument at all for messages without placeholders. */
export type ParamsOf<K extends MessageKey> = [ParamNames<K>] extends [never]
  ? []
  : [params: Readonly<Record<ParamNames<K>, string | number>>];

/** A message that is not translated yet: what view models carry instead of text. */
export interface Message {
  readonly key: MessageKey;
  readonly params?: MessageParams;
}

/** Several messages shown as one line, joined with the language's list separator. */
export interface MessageList {
  readonly list: readonly Message[];
}

export type Text = Message | MessageList;

export const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<MessageKey, MessageValue>>>> = {
  'zh-CN': zhCN,
  en,
};

/** Builds a `Message` with its parameters checked against the template. */
export function msg<K extends MessageKey>(key: K, ...params: ParamsOf<K>): Message {
  return params[0] === undefined ? { key } : { key, params: params[0] };
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
const numberFormats = new Map<Locale, Intl.NumberFormat>();

function pluralCategory(target: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(target);
  if (!rules) {
    rules = new Intl.PluralRules(target);
    pluralRules.set(target, rules);
  }
  return rules.select(count);
}

/** A plain number in the locale's notation (grouping, digits). */
export function formatNumberFor(target: Locale, value: number): string {
  let format = numberFormats.get(target);
  if (!format) {
    format = new Intl.NumberFormat(target);
    numberFormats.set(target, format);
  }
  return format.format(value);
}

function template(target: Locale, key: MessageKey, params: MessageParams | undefined): string {
  const value: MessageValue | undefined = DICTIONARIES[target][key] ?? zhCN[key];
  if (value === undefined) return key;
  if (typeof value === 'string') return value;
  const count = Number(params?.count);
  return Number.isFinite(count) && pluralCategory(target, count) === 'one'
    ? value.one
    : value.other;
}

/** Translates into a given locale. Not reactive; `t()` is the reactive form. */
export function translate(target: Locale, key: MessageKey, params?: MessageParams): string {
  return template(target, key, params).replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const param = params?.[name];
    if (param === undefined) return placeholder;
    return typeof param === 'number' ? formatNumberFor(target, param) : param;
  });
}

function translateText(target: Locale, text: Text): string {
  if ('list' in text) {
    return text.list
      .map((item) => translate(target, item.key, item.params))
      .join(translate(target, 'list.separator'));
  }
  return translate(target, text.key, text.params);
}

/**
 * Translates a key (with type-checked parameters) or a `Message`/`MessageList` from a view model
 * into the current language.
 */
export function t<K extends MessageKey>(key: K, ...params: ParamsOf<K>): string;
export function t(text: Text): string;
export function t(keyOrText: MessageKey | Text, params?: MessageParams): string {
  const target = locale.value;
  return typeof keyOrText === 'string'
    ? translate(target, keyOrText, params)
    : translateText(target, keyOrText);
}
