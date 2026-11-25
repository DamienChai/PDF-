/**
 * From the password a person typed to the byte strings a PDF security handler works with.
 *
 * A PDF password is bytes, and which bytes depends on who wrote the file:
 *   - R5/R6 (AES-256): UTF-8 after SASLprep, at most 127 bytes.
 *   - R2-R4 (RC4, AES-128): PDFDocEncoding, at most 32 bytes - on paper. In practice writers used
 *     whatever their platform handed them: Windows code pages, UTF-8, GBK, Big5, Shift_JIS ...
 *
 * For opening we therefore produce an ordered list of candidates and let the engine try each one.
 * The key check is cryptographic, so a candidate either is the password or it is not; trying
 * more encodings cannot open a file with the wrong password.
 */
import { saslprep } from './saslprep';
import { PdfEngineError, type EncryptOptions } from './types';

/** Longest password the standard security handler looks at, per revision. */
export function maxPasswordBytes(revision: number): number {
  return revision >= 5 ? 127 : 32;
}

const textEncoder = new TextEncoder();
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

function utf8(text: string): Uint8Array {
  return textEncoder.encode(text);
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) {
      return false;
    }
  }
  return true;
}

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i]! + 0x100).toString(16).slice(1);
  }
  return hex;
}

// ---------------------------------------------------------------------------------------------
// Single-byte encodings with fixed tables
// ---------------------------------------------------------------------------------------------

/** Code points of PDFDocEncoding 0x18..0x1F (ISO 32000-1, table D.2). */
const PDF_DOC_LOW: readonly number[] = [
  0x02d8, 0x02c7, 0x02c6, 0x02d9, 0x02dd, 0x02db, 0x02da, 0x02dc,
];

/** Code points of PDFDocEncoding 0x80..0x9E. */
const PDF_DOC_HIGH: readonly number[] = [
  0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x0192, 0x2044, 0x2039, 0x203a, 0x2212, 0x2030,
  0x201e, 0x201c, 0x201d, 0x2018, 0x2019, 0x201a, 0x2122, 0xfb01, 0xfb02, 0x0141, 0x0152, 0x0160,
  0x0178, 0x017d, 0x0131, 0x0142, 0x0153, 0x0161, 0x017e,
];

/** PDFDocEncoding 0xA0 is the euro sign. */
const PDF_DOC_EURO_BYTE = 0xa0;
const EURO_SIGN = 0x20ac;

/**
 * Code points of Windows-1252 0x80..0x9F. The five unassigned bytes map to the C1 control with
 * the same value, as in the WHATWG encoding.
 */
const WINDOWS_1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

let pdfDocSpecials: Map<number, number> | undefined;
let windows1252Specials: Map<number, number> | undefined;

function getPdfDocSpecials(): Map<number, number> {
  if (!pdfDocSpecials) {
    pdfDocSpecials = new Map();
    PDF_DOC_LOW.forEach((codePoint, i) => pdfDocSpecials!.set(codePoint, 0x18 + i));
    PDF_DOC_HIGH.forEach((codePoint, i) => pdfDocSpecials!.set(codePoint, 0x80 + i));
    pdfDocSpecials.set(EURO_SIGN, PDF_DOC_EURO_BYTE);
  }
  return pdfDocSpecials;
}

function getWindows1252Specials(): Map<number, number> {
  if (!windows1252Specials) {
    windows1252Specials = new Map();
    WINDOWS_1252_HIGH.forEach((codePoint, i) => windows1252Specials!.set(codePoint, 0x80 + i));
  }
  return windows1252Specials;
}

type CodePointEncoder = (codePoint: number) => number | undefined;

/** Encodes with a per-code-point function returning one byte, or undefined if not encodable. */
function encodeSingleByte(text: string, encode: CodePointEncoder): Uint8Array | null {
  const out = new Uint8Array(text.length);
  let length = 0;
  for (const char of text) {
    const byte = encode(char.codePointAt(0)!);
    if (byte === undefined) {
      return null;
    }
    out[length++] = byte;
  }
  return out.subarray(0, length);
}

/** PDFDocEncoding, or null if the text contains a character it cannot represent. */
export function encodePdfDoc(text: string): Uint8Array | null {
  const specials = getPdfDocSpecials();
  return encodeSingleByte(text, (cp) => {
    // 0x18-0x1F, 0x7F-0xA0 and 0xAD are either undefined or mean something other than the
    // Unicode character with the same number.
    if (cp < 0x18 || (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa1 && cp <= 0xff && cp !== 0xad)) {
      return cp;
    }
    return specials.get(cp);
  });
}

function encodeWindows1252(text: string): Uint8Array | null {
  const specials = getWindows1252Specials();
  return encodeSingleByte(text, (cp) =>
    cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) ? cp : specials.get(cp),
  );
}

function encodeLatin1(text: string): Uint8Array | null {
  return encodeSingleByte(text, (cp) => (cp <= 0xff ? cp : undefined));
}

// ---------------------------------------------------------------------------------------------
// Legacy encodings via TextDecoder
// ---------------------------------------------------------------------------------------------

/**
 * Browsers ship decoders for the legacy encodings but no encoders. The reverse table is built by
 * decoding every byte sequence once (a single TextDecoder call per encoding, on first use).
 * A table value is one byte, or 0x10000 | lead << 8 | trail for a two-byte sequence.
 */
interface LegacyEncoding {
  label: string;
  multiByte: boolean;
}

const DOUBLE = 0x10000;

/** Tried in this order. The multi-byte ones are what CJK PDF tools used before Unicode passwords. */
const LEGACY_ENCODINGS: readonly LegacyEncoding[] = [
  { label: 'gbk', multiByte: true },
  { label: 'big5', multiByte: true },
  { label: 'shift_jis', multiByte: true },
  { label: 'euc-jp', multiByte: true },
  { label: 'euc-kr', multiByte: true },
  { label: 'windows-1251', multiByte: false },
  { label: 'windows-1250', multiByte: false },
  { label: 'windows-1253', multiByte: false },
  { label: 'windows-1254', multiByte: false },
  { label: 'windows-1255', multiByte: false },
  { label: 'windows-1256', multiByte: false },
  { label: 'windows-1257', multiByte: false },
  { label: 'windows-1258', multiByte: false },
  { label: 'windows-874', multiByte: false },
  { label: 'koi8-r', multiByte: false },
  { label: 'koi8-u', multiByte: false },
  { label: 'ibm866', multiByte: false },
  { label: 'iso-8859-2', multiByte: false },
  { label: 'iso-8859-5', multiByte: false },
  { label: 'iso-8859-7', multiByte: false },
  { label: 'iso-8859-15', multiByte: false },
  { label: 'macintosh', multiByte: false },
];

/** Big5 code points for which the last of several byte sequences is the canonical one (WHATWG). */
const BIG5_PREFER_LAST = new Set([0x2550, 0x255e, 0x2561, 0x256a, 0x5341, 0x5345]);

const reverseTables = new Map<string, Map<number, number> | null>();

function leadBytes(label: string): number[] {
  const leads: number[] = [];
  // Big5: sequences below 0xA1 are HKSCS extensions that encoders do not produce.
  for (let lead = label === 'big5' ? 0xa1 : 0x81; lead <= 0xfe; lead++) {
    leads.push(lead);
  }
  if (label === 'shift_jis') {
    // 0xED/0xEE duplicate the IBM extension rows at 0xFA-0xFC, which are the ones encoders use.
    return [...leads.filter((b) => b !== 0xed && b !== 0xee), 0xed, 0xee];
  }
  return leads;
}

function buildReverseTable(encoding: LegacyEncoding): Map<number, number> | null {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding.label);
  } catch {
    return null; // this runtime does not ship the encoding
  }
  // Every sequence is followed by a line feed. A decoder never swallows an ASCII byte as part of
  // an invalid sequence, so splitting on line feeds gives exactly one segment per sequence.
  const values: number[] = [];
  const bytes: number[] = [];
  for (let single = 0x80; single <= 0xff; single++) {
    values.push(single);
    bytes.push(single, 0x0a);
  }
  if (encoding.multiByte) {
    for (const lead of leadBytes(encoding.label)) {
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        if (trail === 0x7f) {
          continue;
        }
        values.push(DOUBLE | (lead << 8) | trail);
        bytes.push(lead, trail, 0x0a);
      }
    }
  }
  const segments = decoder.decode(new Uint8Array(bytes)).split('\n');
  const preferLast = encoding.label === 'big5' ? BIG5_PREFER_LAST : undefined;
  const table = new Map<number, number>();
  for (let i = 0; i < values.length; i++) {
    const segment = segments[i]!;
    const codePoint = segment.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint < 0x80 ||
      codePoint === 0xfffd ||
      segment.length !== (codePoint > 0xffff ? 2 : 1)
    ) {
      continue;
    }
    if (!table.has(codePoint) || preferLast?.has(codePoint)) {
      table.set(codePoint, values[i]!);
    }
  }
  return table;
}

function encodeLegacy(text: string, encoding: LegacyEncoding): Uint8Array | null {
  let table = reverseTables.get(encoding.label);
  if (table === undefined) {
    table = buildReverseTable(encoding);
    reverseTables.set(encoding.label, table);
  }
  if (!table) {
    return null;
  }
  const out = new Uint8Array(text.length * 2);
  let length = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint < 0x80) {
      out[length++] = codePoint;
      continue;
    }
    const value = table.get(codePoint);
    if (value === undefined) {
      return null;
    }
    if (value >= DOUBLE) {
      out[length++] = (value >> 8) & 0xff;
    }
    out[length++] = value & 0xff;
  }
  return out.subarray(0, length);
}

// ---------------------------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------------------------

/**
 * Candidate byte strings for opening a document encrypted with the given security handler
 * revision, most likely first. Empty for an empty password: the engine always tries that itself.
 * A printable-ASCII password has exactly one candidate.
 */
export function openCandidates(password: string, revision: number): Uint8Array[] {
  if (password === '') {
    return [];
  }
  const limit = maxPasswordBytes(revision);
  const seen = new Set<string>();
  const candidates: Uint8Array[] = [];
  const add = (bytes: Uint8Array | null): void => {
    if (!bytes || bytes.length === 0) {
      return;
    }
    // The handler ignores everything past the limit, so longer inputs are equivalent.
    const truncated = bytes.length > limit ? bytes.subarray(0, limit) : bytes;
    // qpdf takes passwords as C strings: a zero byte cannot be passed on.
    if (truncated.includes(0)) {
      return;
    }
    const key = toHex(truncated);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(truncated);
    }
  };

  if (isAscii(password)) {
    add(utf8(password));
    return candidates;
  }

  const nfc = password.normalize('NFC');
  const unicodeForms = (): void => {
    add(utf8(saslprep(password).value));
    // Implementations disagree on U+200B: a space (libidn) or nothing (others).
    add(utf8(saslprep(password.replaceAll(ZERO_WIDTH_SPACE, '')).value));
    add(utf8(password));
    add(utf8(nfc));
    add(utf8(password.normalize('NFKC')));
    add(utf8(password.normalize('NFD')));
  };
  const singleByteForms = (): void => {
    add(encodePdfDoc(nfc));
    add(encodeWindows1252(nfc));
    add(encodeLatin1(nfc));
  };

  if (revision >= 5) {
    unicodeForms();
    singleByteForms();
  } else {
    singleByteForms();
    add(utf8(password));
    add(utf8(nfc));
    unicodeForms();
  }
  for (const encoding of LEGACY_ENCODINGS) {
    add(encodeLegacy(nfc, encoding));
  }
  return candidates;
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

export type NewPasswordProblem =
  'password-missing' | 'password-too-long' | 'password-not-encodable';

export interface NewPasswords {
  user: Uint8Array;
  owner: Uint8Array;
}

type NewPasswordInput = Pick<EncryptOptions, 'algorithm' | 'userPassword' | 'ownerPassword'>;

function encodeNewPassword(
  password: string,
  algorithm: EncryptOptions['algorithm'],
): Uint8Array | NewPasswordProblem {
  let bytes: Uint8Array | null;
  let limit: number;
  if (algorithm === 'aes-256') {
    const prepared = saslprep(password);
    // A bidi violation still has a well-defined normalised form, and that form is what every
    // reader derives from the same input, so it is used. Prohibited characters are refused.
    bytes = prepared.failure === 'prohibited' ? null : utf8(prepared.value);
    limit = 127;
  } else {
    bytes = encodePdfDoc(password.normalize('NFC'));
    limit = 32;
  }
  // SASLprep can reduce a password to nothing (e.g. only soft hyphens); writing that would
  // silently produce a document without the password the user asked for.
  if (!bytes || bytes.includes(0) || (password !== '' && bytes.length === 0)) {
    return 'password-not-encodable';
  }
  return bytes.length > limit ? 'password-too-long' : bytes;
}

function resolveNewPasswords(input: NewPasswordInput): NewPasswords | NewPasswordProblem {
  if (input.userPassword === '' && input.ownerPassword === '') {
    return 'password-missing';
  }
  const user = encodeNewPassword(input.userPassword, input.algorithm);
  if (typeof user === 'string') {
    return user;
  }
  if (input.ownerPassword === '') {
    return { user, owner: user };
  }
  const owner = encodeNewPassword(input.ownerPassword, input.algorithm);
  return typeof owner === 'string' ? owner : { user, owner };
}

/**
 * Checks the passwords of an encrypt request without running it. Returns null if they are fine,
 * otherwise the code `process` would reject with. Cheap and synchronous: usable for validating a
 * form while the user types.
 */
export function checkNewPasswords(input: NewPasswordInput): NewPasswordProblem | null {
  const resolved = resolveNewPasswords(input);
  return typeof resolved === 'string' ? resolved : null;
}

/** The byte strings to encrypt with. Throws PdfEngineError for unusable passwords. */
export function encodeNewPasswords(input: NewPasswordInput): NewPasswords {
  const resolved = resolveNewPasswords(input);
  if (typeof resolved === 'string') {
    throw new PdfEngineError(resolved);
  }
  return resolved;
}
