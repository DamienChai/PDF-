/** Shapes shared by the dictionaries and the translator. */

/** English plural forms, selected by the `count` parameter. */
export interface PluralForms {
  readonly one: string;
  readonly other: string;
}

/** A message template: `{name}` placeholders, optionally one template per plural category. */
export type MessageValue = string | PluralForms;

export type MessageParams = Readonly<Record<string, string | number>>;
