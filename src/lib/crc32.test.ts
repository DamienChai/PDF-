import { randomBytes } from 'node:crypto';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, crc32OfBlob } from './crc32';

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('matches zlib for every length around the block boundaries and every alignment', () => {
    for (let length = 0; length <= 200; length++) {
      for (let offset = 0; offset < 4; offset++) {
        const data = randomBytes(length + offset).subarray(offset);
        expect(crc32(data)).toBe(zlibCrc32(data));
      }
    }
    const large = randomBytes(1_000_003);
    expect(crc32(large)).toBe(zlibCrc32(large));
  });

  it('can be fed in chunks of any size', () => {
    const data = randomBytes(100_000);
    const expected = zlibCrc32(data);
    for (const chunk of [1, 3, 15, 16, 17, 63, 64, 65, 977, 4096, 99_999]) {
      let crc = 0;
      for (let offset = 0; offset < data.length; offset += chunk) {
        crc = crc32(data.subarray(offset, offset + chunk), crc);
      }
      expect(crc).toBe(expected);
    }
  });

  it('returns an unsigned 32-bit integer', () => {
    for (let i = 0; i < 200; i++) {
      const value = crc32(randomBytes(64 + i));
      expect(Number.isInteger(value) && value >= 0 && value <= 0xffffffff).toBe(true);
    }
  });
});

describe('crc32OfBlob', () => {
  it('reads the blob in chunks', async () => {
    const data = randomBytes(300_000);
    const blob = new Blob([data.subarray(0, 123_456), data.subarray(123_456)]);
    const expected = zlibCrc32(data);
    expect(await crc32OfBlob(blob)).toBe(expected);
    expect(await crc32OfBlob(blob, 1000)).toBe(expected);
    expect(await crc32OfBlob(blob, 65_536)).toBe(expected);
    expect(await crc32OfBlob(new Blob([]))).toBe(0);
  });

  it('never asks for more than one chunk at a time', async () => {
    const data = randomBytes(10_000);
    const blob = new Blob([data]);
    const sizes: number[] = [];
    const original = blob.slice.bind(blob);
    blob.slice = (start?: number, end?: number, type?: string) => {
      sizes.push((end ?? blob.size) - (start ?? 0));
      return original(start, end, type);
    };
    expect(await crc32OfBlob(blob, 4096)).toBe(zlibCrc32(data));
    expect(sizes).toEqual([4096, 4096, 4096]);
  });
});
