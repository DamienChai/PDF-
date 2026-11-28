/**
 * Running text whose last line is never a stub ("……文件也将无法 / 打开。"). The end of the text is
 * set as one piece, so the last line break falls in front of it: in Chinese in front of the last
 * clause, or of the last few words when that clause is long; in English in front of the last
 * two words.
 *
 * In English the piece is an inline block: where it is wider than its line it wraps like any
 * other text, so nothing can overflow. Chinese has no space where the piece begins, and an
 * inline block gets one in the text that assistive technology is given: the name of a control
 * would read "……的大 多数软件". There the piece stays ordinary inline text (base.css): a short
 * one is set without line breaks; a long clause does not break between its characters unless it
 * is wider than the line, nor inside a term like "AES-256", and its last words do not break at
 * all.
 */
import type { ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';

/** Chinese text is set differently from text in Latin script. */
const HAN = /\p{Script=Han}/u;
/** Characters that take a full em: Han, kana, full-width punctuation and forms. */
const FULL_WIDTH = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;
/** Where a Chinese clause ends. */
const CLAUSE_MARK = /[，。；：！？、]/;
/** What ends a sentence, and the white space around it. */
const SENTENCE_END = /[\s。．.！!？?…]/;
const OPENING = /[（(“‘「『《]/;
const CLOSING = /[）)]/;

/** Ems that make a respectable last line. */
const MIN_TAIL = 4;
/** A longer clause is not kept whole: the line in front of it would end too early. */
const MAX_TAIL = 16;
/** A clause from this width on may need two lines in a narrow column: its own end is kept too. */
const LONG_TAIL = 8;
/** A piece that is set without any line break is no wider than this: it fits every column. */
const MAX_TIGHT = 10;
/** The longest pair of English words that is kept together. */
const MAX_LATIN_TAIL = 24;

/** The width of a text in ems, near enough: full-width characters 1, all others half. */
function widthOf(text: string): number {
  let width = 0;
  for (const char of text) width += FULL_WIDTH.test(char) ? 1 : 0.5;
  return width;
}

/** A letter, digit or mark of a Latin word or number: "AES-256" is not taken apart. */
function isLatin(char: string): boolean {
  return char !== '' && !/\s/.test(char) && !FULL_WIDTH.test(char) && !OPENING.test(char);
}

/** A tail never starts inside a Latin word or number, nor right after an opening bracket. */
function settle(text: string, start: number): number {
  let at = start;
  while (at > 0) {
    const before = text.charAt(at - 1);
    const inside = isLatin(before) && isLatin(text.charAt(at));
    if (!inside && !OPENING.test(before)) break;
    at--;
  }
  return at;
}

let segmenter: Intl.Segmenter | undefined;

/**
 * The last words of a Chinese text that together make a respectable line. The piece starts with
 * a word of two characters or more: a single one is often the end of the word in front of it
 * ("输入法") or a particle that belongs to it ("文件的").
 */
function wordTail(text: string, end: number): number {
  if (typeof Intl.Segmenter !== 'function') return 0;
  segmenter ??= new Intl.Segmenter('zh', { granularity: 'word' });
  const words = [...segmenter.segment(text)];
  for (let index = words.length - 1; index > 0; index--) {
    const word = words[index]!;
    if (!word.isWordLike || word.index >= end || word.segment.length < 2) continue;
    const start = settle(text, word.index);
    if (widthOf(text.slice(start, end)) >= MIN_TAIL) return start;
  }
  return 0;
}

/** Where the text proper ends: in front of the full stop and the white space after it. */
function bodyEnd(text: string): number {
  let end = text.length;
  while (end > 0 && SENTENCE_END.test(text.charAt(end - 1))) end--;
  return end;
}

function chineseTail(text: string): number {
  const end = bodyEnd(text);
  // A remark in brackets at the very end stays whole: "RC4 40 位（已过时）".
  const bracketed = CLOSING.test(text.charAt(end - 1));
  for (let index = end - 2; index > 0; index--) {
    const char = text.charAt(index);
    const opens = bracketed && OPENING.test(char);
    if (!opens && !CLAUSE_MARK.test(char)) continue;
    let start = opens ? index : index + 1;
    while (/\s/.test(text.charAt(start))) start++;
    const width = widthOf(text.slice(start, end));
    if (width > MAX_TAIL) break;
    if (width >= MIN_TAIL) return settle(text, start);
  }
  return wordTail(text, end);
}

function latinTail(text: string): number {
  const body = text.trimEnd();
  const words = body.split(' ');
  // Two words, and the word in front of a number with it: "version 3 (AGPL-3.0)".
  let count = 2;
  while (count < words.length && /^\d+$/.test(words[words.length - count]!)) count++;
  if (words.length < count + 2) return 0;
  const tail = words.slice(-count).join(' ');
  return tail.length > MAX_LATIN_TAIL ? 0 : body.length - tail.length;
}

/** Splits a text into what may wrap freely and the end that stays together (may be empty). */
export function splitTail(text: string): readonly [head: string, tail: string] {
  const at = HAN.test(text) ? chineseTail(text) : latinTail(text);
  return at > 0 ? [text.slice(0, at), text.slice(at)] : [text, ''];
}

/** The same for the end piece itself, when it is a long Chinese clause. */
export function splitLongTail(tail: string): readonly [head: string, tail: string] {
  const at = HAN.test(tail) && widthOf(tail) > LONG_TAIL ? wordTail(tail, bodyEnd(tail)) : 0;
  return at > 0 ? [tail.slice(0, at), tail.slice(at)] : [tail, ''];
}

/**
 * A text as `Prose` sets it: what wraps freely, the last clause, and the last words of that
 * clause when it is a long one (each may be empty). `tight` says which of the two pieces is short
 * enough to be set without any line break.
 */
export function splitKept(text: string): {
  free: string;
  clause: string;
  end: string;
  tight: 'clause' | 'end' | null;
} {
  const [free, tail] = splitTail(text);
  const [clause, end] = splitLongTail(tail);
  // A clause that has no last words to keep (it is short, or they are all of it) is the piece.
  const piece = end || clause;
  const tight = piece && widthOf(piece) <= MAX_TIGHT ? (end ? 'end' : 'clause') : null;
  return { free, clause, end, tight };
}

/**
 * A term in Latin script with a hyphen or a slash inside: "AES-256", "AGPL-3.0". A line may
 * break after those marks, which takes the term apart.
 */
const TERM = /([0-9A-Za-z][0-9A-Za-z.+_]*(?:[-/][0-9A-Za-z.+_]+)+)/;

/**
 * The terms of a text and what stands between them, in turn: every second part is a term. One
 * that is too long to be set without line breaks counts as text.
 */
export function splitTerms(text: string): string[] {
  const parts = [''];
  text.split(TERM).forEach((part, index) => {
    if (index % 2 === 1 && widthOf(part) <= MAX_TIGHT) parts.push(part, '');
    else parts[parts.length - 1] += part;
  });
  return parts;
}

/**
 * A Chinese clause that is not set without line breaks as a whole could still break where
 * `word-break: keep-all` does not reach: at its spaces ("2011 / 年后的……") and inside a term
 * ("AES- / 256"). The spaces become no-break spaces, which is what belongs between a number and
 * its unit anyway; a term is set without line breaks.
 */
function unbreakable(piece: string, han: boolean): ComponentChildren {
  if (!han) return piece;
  return splitTerms(piece.replaceAll(' ', '\u00a0')).map((part, index) =>
    index % 2 === 1 ? <span class="keep__term">{part}</span> : part,
  );
}

export function Prose({ text }: { text: string }) {
  const { free, clause, end, tight } = useMemo(() => splitKept(text), [text]);
  if (!clause) return <>{text}</>;
  const han = HAN.test(text);
  return (
    <>
      {free}
      <span class={tight === 'clause' ? 'keep keep--tight' : 'keep'}>
        {tight === 'clause' ? clause : unbreakable(clause, han)}
        {end && (
          <span class={tight === 'end' ? 'keep keep--tight' : 'keep'}>
            {tight === 'end' ? end : unbreakable(end, han)}
          </span>
        )}
      </span>
    </>
  );
}
