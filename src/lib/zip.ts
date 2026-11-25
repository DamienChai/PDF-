/**
 * Minimal ZIP writer (APPNOTE 6.3.x): STORE method, UTF-8 names, ZIP64 when required.
 *
 * The archive is returned as a Blob made of small header buffers interleaved with the original
 * file Blobs, so file contents are referenced, not copied. The only pass over the data is the
 * chunked CRC-32 calculation.
 */
import { crc32OfBlob } from './crc32';
import { sanitizeFileName, uniqueNames } from './filename';
import type { OutputFile } from './save';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_END64_LOCATOR = 0x07064b50;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_SIZE = 22;
const END64_SIZE = 56;
const END64_LOCATOR_SIZE = 20;

/** Values at or above these do not fit the classic fields; the value itself means "see ZIP64". */
const MAX_32 = 0xffffffff;
const MAX_16 = 0xffff;

const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
/** Bit 11: file names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const EXTRA_ZIP64 = 0x0001;
/**
 * "Version made by" host system 3 (Unix). With host 0 (MS-DOS) Info-ZIP's `unzip`, as shipped by
 * Debian and Ubuntu, re-decodes names as an OEM code page even when the UTF-8 flag is set and
 * turns CJK names into mojibake.
 */
const MADE_BY_UNIX = 3 << 8;
/** External attributes for a Unix-made entry: `S_IFREG | 0644` in the upper 16 bits. */
const UNIX_REGULAR_FILE_RW_R_R = (0o100644 << 16) >>> 0;

export interface ZipOptions {
  /** Emit ZIP64 structures even when nothing overflows (for tests without 4 GiB of data). */
  forceZip64?: boolean;
  /** Timestamp for entries whose Blob is not a `File`. Default: now. */
  now?: Date;
}

interface Entry {
  name: Uint8Array;
  size: number;
  crc: number;
  dosTime: number;
  dosDate: number;
  /** Offset of the local header from the start of the archive. */
  offset: number;
  /** Sizes are stored in a ZIP64 extra field (local and central header). */
  zip64Sizes: boolean;
}

/**
 * Builds a ZIP archive (STORE method — PDFs are already compressed) without loading all files
 * into memory at once. UTF-8 file names; ZIP64 when sizes or counts require it.
 *
 * Names are sanitised and made unique, so every entry can be extracted on every platform.
 */
export function createZip(files: readonly OutputFile[]): Promise<Blob> {
  return buildZip(files);
}

export async function buildZip(
  files: readonly OutputFile[],
  options: ZipOptions = {},
): Promise<Blob> {
  return new Blob(await zipParts(files, options), { type: 'application/zip' });
}

/**
 * The archive as a list of parts: header buffers and, by reference, the Blobs of the files.
 * Concatenated in order they form the ZIP file.
 */
export async function zipParts(
  files: readonly OutputFile[],
  options: ZipOptions = {},
): Promise<(Uint8Array<ArrayBuffer> | Blob)[]> {
  const forceZip64 = options.forceZip64 === true;
  const now = options.now ?? new Date();
  const names = uniqueNames(files.map((file) => sanitizeFileName(file.name)));
  const encoder = new TextEncoder();

  const parts: (Uint8Array<ArrayBuffer> | Blob)[] = [];
  const entries: Entry[] = [];
  let offset = 0;

  for (const [index, file] of files.entries()) {
    const { blob } = file;
    const modified = isFile(blob) ? new Date(blob.lastModified) : now;
    const { dosTime, dosDate } = toDosDateTime(modified);
    const entry: Entry = {
      name: encoder.encode(names[index]!),
      size: blob.size,
      crc: await crc32OfBlob(blob),
      dosTime,
      dosDate,
      offset,
      zip64Sizes: forceZip64 || blob.size >= MAX_32,
    };
    const header = localHeader(entry);
    parts.push(header, blob);
    entries.push(entry);
    offset += header.byteLength + blob.size;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const entry of entries) {
    const header = centralHeader(entry, forceZip64);
    parts.push(header);
    centralSize += header.byteLength;
  }

  const needsZip64End =
    forceZip64 || entries.length >= MAX_16 || centralSize >= MAX_32 || centralOffset >= MAX_32;
  if (needsZip64End) {
    parts.push(zip64End(entries.length, centralSize, centralOffset));
  }
  parts.push(end(entries.length, centralSize, centralOffset, forceZip64));
  return parts;
}

function isFile(blob: Blob): blob is File {
  return typeof File !== 'undefined' && blob instanceof File;
}

/** MS-DOS date/time: local time, two-second resolution, years 1980–2107. */
export function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = date.getFullYear();
  if (Number.isNaN(year) || year < 1980) return { dosTime: 0, dosDate: (1 << 5) | 1 };
  if (year > 2107) {
    return { dosTime: (23 << 11) | (59 << 5) | 29, dosDate: (127 << 9) | (12 << 5) | 31 };
  }
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Little-endian writer over a fixed-size buffer. */
class Writer {
  readonly bytes: Uint8Array<ArrayBuffer>;
  private readonly view: DataView;
  private position = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  u16(value: number): this {
    this.view.setUint16(this.position, value, true);
    this.position += 2;
    return this;
  }

  u32(value: number): this {
    this.view.setUint32(this.position, value, true);
    this.position += 4;
    return this;
  }

  u64(value: number): this {
    this.view.setBigUint64(this.position, BigInt(value), true);
    this.position += 8;
    return this;
  }

  raw(data: Uint8Array): this {
    this.bytes.set(data, this.position);
    this.position += data.length;
    return this;
  }
}

function localHeader(entry: Entry): Uint8Array<ArrayBuffer> {
  // Both sizes must be present in the local ZIP64 field, in this order.
  const extraSize = entry.zip64Sizes ? 4 + 16 : 0;
  const writer = new Writer(LOCAL_HEADER_SIZE + entry.name.length + extraSize);
  writer
    .u32(SIG_LOCAL)
    .u16(entry.zip64Sizes ? VERSION_ZIP64 : VERSION_DEFAULT)
    .u16(FLAG_UTF8)
    .u16(METHOD_STORE)
    .u16(entry.dosTime)
    .u16(entry.dosDate)
    .u32(entry.crc)
    .u32(entry.zip64Sizes ? MAX_32 : entry.size)
    .u32(entry.zip64Sizes ? MAX_32 : entry.size)
    .u16(entry.name.length)
    .u16(extraSize)
    .raw(entry.name);
  if (entry.zip64Sizes) {
    writer.u16(EXTRA_ZIP64).u16(16).u64(entry.size).u64(entry.size);
  }
  return writer.bytes;
}

function centralHeader(entry: Entry, forceZip64: boolean): Uint8Array<ArrayBuffer> {
  const zip64Offset = forceZip64 || entry.offset >= MAX_32;
  // Only the fields that overflow go into the central ZIP64 field: sizes first, then the offset.
  const extraData = (entry.zip64Sizes ? 16 : 0) + (zip64Offset ? 8 : 0);
  const extraSize = extraData > 0 ? 4 + extraData : 0;
  const version = extraData > 0 ? VERSION_ZIP64 : VERSION_DEFAULT;
  const writer = new Writer(CENTRAL_HEADER_SIZE + entry.name.length + extraSize);
  writer
    .u32(SIG_CENTRAL)
    .u16(MADE_BY_UNIX | version)
    .u16(version)
    .u16(FLAG_UTF8)
    .u16(METHOD_STORE)
    .u16(entry.dosTime)
    .u16(entry.dosDate)
    .u32(entry.crc)
    .u32(entry.zip64Sizes ? MAX_32 : entry.size)
    .u32(entry.zip64Sizes ? MAX_32 : entry.size)
    .u16(entry.name.length)
    .u16(extraSize)
    .u16(0) // comment length
    .u16(0) // disk number start
    .u16(0) // internal attributes
    .u32(UNIX_REGULAR_FILE_RW_R_R)
    .u32(zip64Offset ? MAX_32 : entry.offset)
    .raw(entry.name);
  if (extraData > 0) {
    writer.u16(EXTRA_ZIP64).u16(extraData);
    if (entry.zip64Sizes) writer.u64(entry.size).u64(entry.size);
    if (zip64Offset) writer.u64(entry.offset);
  }
  return writer.bytes;
}

/** ZIP64 end-of-central-directory record followed by its locator. */
function zip64End(
  count: number,
  centralSize: number,
  centralOffset: number,
): Uint8Array<ArrayBuffer> {
  const writer = new Writer(END64_SIZE + END64_LOCATOR_SIZE);
  writer
    .u32(SIG_END64)
    .u64(END64_SIZE - 12) // size of the rest of this record
    .u16(MADE_BY_UNIX | VERSION_ZIP64)
    .u16(VERSION_ZIP64)
    .u32(0) // this disk
    .u32(0) // disk with the central directory
    .u64(count)
    .u64(count)
    .u64(centralSize)
    .u64(centralOffset)
    .u32(SIG_END64_LOCATOR)
    .u32(0) // disk with the ZIP64 end record
    .u64(centralOffset + centralSize)
    .u32(1); // total number of disks
  return writer.bytes;
}

function end(
  count: number,
  centralSize: number,
  centralOffset: number,
  forceZip64: boolean,
): Uint8Array<ArrayBuffer> {
  // A field holding the marker value tells readers to take it from the ZIP64 end record.
  const count16 = forceZip64 || count >= MAX_16 ? MAX_16 : count;
  const writer = new Writer(END_SIZE);
  writer
    .u32(SIG_END)
    .u16(0) // this disk
    .u16(0) // disk with the central directory
    .u16(count16)
    .u16(count16)
    .u32(forceZip64 || centralSize >= MAX_32 ? MAX_32 : centralSize)
    .u32(forceZip64 || centralOffset >= MAX_32 ? MAX_32 : centralOffset)
    .u16(0); // comment length
  return writer.bytes;
}
