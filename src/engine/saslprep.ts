/**
 * SASLprep (RFC 4013), the stringprep profile PDF 2.0 prescribes for AES-256 passwords
 * (ISO 32000-2, 7.6.4.3.2 / 7.6.4.3.3).
 *
 * Unassigned code points are allowed (a "query" in RFC 3454 terms): the RFC tables stop at
 * Unicode 3.2, and treating everything newer (emoji, many CJK ideographs) as forbidden would make
 * ordinary passwords unusable. Normalisation uses the runtime's NFKC, which agrees with
 * Unicode 3.2 for every code point that existed then.
 */
import { L_CAT, MAP_TO_NOTHING, NON_ASCII_SPACE, PROHIBITED, RAND_AL_CAT } from './stringprep-data';

export type SaslprepFailure =
  /** Contains a character RFC 4013 forbids (control characters, private use, non-characters …). */
  | 'prohibited'
  /** Mixes right-to-left and left-to-right characters in a way RFC 3454 section 6 forbids. */
  | 'bidi';

export interface SaslprepResult {
  /** The mapped and NFKC-normalised string. Present even when `failure` is set. */
  value: string;
  failure: SaslprepFailure | null;
}

/** Sorted, flattened inclusive ranges: [start0, end0, start1, end1, …]. */
type RangeTable = Uint32Array;

function unpack(packed: string): RangeTable {
  const fields = packed.split(',');
  const table = new Uint32Array(fields.length);
  let position = 0;
  for (let i = 0; i < fields.length; i += 2) {
    const start = position + parseInt(fields[i]!, 36);
    const end = start + parseInt(fields[i + 1]!, 36);
    table[i] = start;
    table[i + 1] = end;
    position = end;
  }
  return table;
}

function contains(table: RangeTable, codePoint: number): boolean {
  let low = 0;
  let high = table.length / 2 - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (codePoint < table[2 * mid]!) {
      high = mid - 1;
    } else if (codePoint > table[2 * mid + 1]!) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

interface Tables {
  mapToNothing: RangeTable;
  nonAsciiSpace: RangeTable;
  prohibited: RangeTable;
  randAlCat: RangeTable;
  lCat: RangeTable;
}

let tables: Tables | undefined;

function getTables(): Tables {
  tables ??= {
    mapToNothing: unpack(MAP_TO_NOTHING),
    nonAsciiSpace: unpack(NON_ASCII_SPACE),
    prohibited: unpack(PROHIBITED),
    randAlCat: unpack(RAND_AL_CAT),
    lCat: unpack(L_CAT),
  };
  return tables;
}

function isPrintableAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x20 || unit > 0x7e) {
      return false;
    }
  }
  return true;
}

export function saslprep(input: string): SaslprepResult {
  if (isPrintableAscii(input)) {
    return { value: input, failure: null };
  }
  const t = getTables();

  // 1. Map (RFC 4013 2.1): non-ASCII spaces become U+0020, "commonly mapped to nothing" vanishes.
  // U+200B is in both tables; the space mapping wins, as in GNU libidn.
  let mapped = '';
  for (const char of input) {
    const codePoint = char.codePointAt(0)!;
    if (contains(t.nonAsciiSpace, codePoint)) {
      mapped += ' ';
    } else if (!contains(t.mapToNothing, codePoint)) {
      mapped += char;
    }
  }

  // 2. Normalise (2.2).
  const value = mapped.normalize('NFKC');

  // 3. Prohibited output (2.3) and 4. bidirectional check (2.4, RFC 3454 section 6).
  let prohibited = false;
  let hasRandAl = false;
  let hasL = false;
  let firstIsRandAl = false;
  let lastIsRandAl = false;
  let first = true;
  for (const char of value) {
    const codePoint = char.codePointAt(0)!;
    if (contains(t.prohibited, codePoint) || contains(t.nonAsciiSpace, codePoint)) {
      prohibited = true;
    }
    const randAl = contains(t.randAlCat, codePoint);
    hasRandAl ||= randAl;
    hasL ||= contains(t.lCat, codePoint);
    if (first) {
      firstIsRandAl = randAl;
      first = false;
    }
    lastIsRandAl = randAl;
  }
  let failure: SaslprepFailure | null = null;
  if (prohibited) {
    failure = 'prohibited';
  } else if (hasRandAl && (hasL || !firstIsRandAl || !lastIsRandAl)) {
    failure = 'bidi';
  }
  return { value, failure };
}
