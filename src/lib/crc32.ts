/**
 * CRC-32 (IEEE 802.3, the polynomial used by ZIP, gzip and PNG), slicing-by-16.
 *
 * Sixteen bytes are folded per iteration using sixteen lookup tables and 32-bit reads. This is
 * roughly ten times faster than the classic byte-at-a-time loop, which matters when hundreds of
 * megabytes of PDFs go into an archive on a phone.
 */

const SLICES = 16;

/** `TABLE[t * 256 + n]`: CRC of byte `n` followed by `t` zero bytes. */
const TABLE = buildTable();

function buildTable(): Int32Array {
  const table = new Int32Array(SLICES * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    table[n] = c;
  }
  for (let t = 1; t < SLICES; t++) {
    for (let n = 0; n < 256; n++) {
      const c = table[(t - 1) * 256 + n]!;
      table[t * 256 + n] = (c >>> 8) ^ table[c & 0xff]!;
    }
  }
  return table;
}

// The word-at-a-time path reads the input through an Int32Array, which only yields the byte order
// the algorithm expects on little-endian machines (every platform browsers run on today).
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Feeds `data` into a running CRC. Start with `0` and pass the previous return value for every
 * further chunk; the return value is always the finished CRC of everything seen so far
 * (an unsigned 32-bit integer).
 */
export function crc32(data: Uint8Array, previous = 0): number {
  const T = TABLE;
  const length = data.length;
  let crc = ~previous;
  let i = 0;

  if (LITTLE_ENDIAN && length >= 64) {
    // Typed-array views must start on a multiple of their element size.
    while ((data.byteOffset + i) & 3) crc = (crc >>> 8) ^ T[(crc ^ data[i++]!) & 0xff]!;
    const words = new Int32Array(data.buffer, data.byteOffset + i, (length - i) >>> 2);
    const end = words.length & ~3;
    for (let w = 0; w < end; w += 4) {
      const a = crc ^ words[w]!;
      const b = words[w + 1]!;
      const c = words[w + 2]!;
      const d = words[w + 3]!;
      crc =
        T[3840 + (a & 0xff)]! ^
        T[3584 + ((a >>> 8) & 0xff)]! ^
        T[3328 + ((a >>> 16) & 0xff)]! ^
        T[3072 + (a >>> 24)]! ^
        T[2816 + (b & 0xff)]! ^
        T[2560 + ((b >>> 8) & 0xff)]! ^
        T[2304 + ((b >>> 16) & 0xff)]! ^
        T[2048 + (b >>> 24)]! ^
        T[1792 + (c & 0xff)]! ^
        T[1536 + ((c >>> 8) & 0xff)]! ^
        T[1280 + ((c >>> 16) & 0xff)]! ^
        T[1024 + (c >>> 24)]! ^
        T[768 + (d & 0xff)]! ^
        T[512 + ((d >>> 8) & 0xff)]! ^
        T[256 + ((d >>> 16) & 0xff)]! ^
        T[d >>> 24]!;
    }
    i += end * 4;
  }

  while (i < length) crc = (crc >>> 8) ^ T[(crc ^ data[i++]!) & 0xff]!;
  return ~crc >>> 0;
}

/** Bytes read per step: large enough to be fast, small enough to keep memory flat. */
const CHUNK_SIZE = 4 * 1024 * 1024;

/** CRC-32 of a Blob, read chunk by chunk so that the file is never in memory as a whole. */
export async function crc32OfBlob(blob: Blob, chunkSize = CHUNK_SIZE): Promise<number> {
  let crc = 0;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const chunk = await blob.slice(offset, offset + chunkSize).arrayBuffer();
    crc = crc32(new Uint8Array(chunk), crc);
  }
  return crc;
}
