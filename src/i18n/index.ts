/**
 * Internationalisation: Simplified Chinese and English.
 *
 *   t('action.unlockCount', { count: 3 })   translate a key (parameters are type-checked)
 *   t(view.chip.label)                      translate a Message from a view model
 *   formatSize(bytes), formatPages(n) …     locale-aware quantities
 *
 * Everything here reads the `locale` signal: components re-render when the language changes.
 */
export { locale } from '../state/settings';
export * from './format';
export * from './labels';
export {
  LOCALES,
  detectLocale,
  isLocale,
  resolveLocale,
  type LanguageSetting,
  type Locale,
} from './locale';
export {
  DICTIONARIES,
  msg,
  t,
  translate,
  type Message,
  type MessageKey,
  type MessageList,
  type ParamNames,
  type ParamsOf,
  type Text,
} from './translate';
export type { MessageParams, MessageValue, PluralForms } from './types';
