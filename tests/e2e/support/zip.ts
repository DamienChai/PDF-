/**
 * A reader for the ZIP archives the app writes ("save all"): enough of the format to list the
 * entries and take them out again, written from the specification (APPNOTE 6.3) and sharing no
 * code with the writer in src/lib/zip.ts.
 */
import { crc32 } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const UTF8_FLAG = 0x0800;
const STORED = 0;

export function readZip(archive: Buffer): ZipEntry[] {
  // The end record is the last thing in the file, after an optional comment of up to 64 KiB.
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 22 - 0xffff); i--) {
    if (archive.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a ZIP archive: no end-of-central-directory record');

  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(offset) !== CENTRAL_HEADER) {
      throw new Error(`entry ${index}: no central directory header at ${offset}`);
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const checksum = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const rawName = archive.subarray(offset + 46, offset + 46 + nameLength);
    const name = rawName.toString((flags & UTF8_FLAG) !== 0 ? 'utf8' : 'latin1');

    if (method !== STORED || compressedSize !== size) {
      throw new Error(`${name}: expected a stored entry, got method ${method}`);
    }
    if (archive.readUInt32LE(localOffset) !== LOCAL_HEADER) {
      throw new Error(`${name}: no local header at ${localOffset}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = archive.subarray(start, start + size);
    if (data.length !== size) throw new Error(`${name}: the archive is truncated`);
    if (crc32(data) !== checksum) throw new Error(`${name}: CRC-32 mismatch`);

    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
