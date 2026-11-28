import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import type { OutputFile } from './save';
import { buildZip, createZip, toDosDateTime, zipParts } from './zip';

// --- An independent, strict reader used to check what the writer produced ----------------------
// (node:assert instead of expect(): it runs a million checks for the 65536-entry archive.)

interface ParsedEntry {
  name: string;
  size: number;
  crc: number;
  flags: number;
  method: number;
  madeBy: number;
  versionNeeded: number;
  externalAttributes: number;
  dosTime: number;
  dosDate: number;
  offset: number;
  hasZip64Extra: boolean;
  data: Uint8Array;
}

interface ParsedZip {
  entries: ParsedEntry[];
  zip64: boolean;
}

function readZip64Extra(
  view: DataView,
  start: number,
  length: number,
  wanted: boolean[],
): number[] {
  const values: number[] = [];
  let position = start;
  while (position < start + length) {
    const id = view.getUint16(position, true);
    const size = view.getUint16(position + 2, true);
    if (id === 0x0001) {
      let field = position + 4;
      for (const want of wanted) {
        if (!want) continue;
        values.push(Number(view.getBigUint64(field, true)));
        field += 8;
      }
      assert.strictEqual(field - (position + 4), size);
      return values;
    }
    position += 4 + size;
  }
  throw new Error('ZIP64 extra field missing');
}

async function parseZip(blob: Blob): Promise<ParsedZip> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder('utf-8', { fatal: true });

  const endOffset = bytes.length - 22;
  assert.strictEqual(view.getUint32(endOffset, true), 0x06054b50);
  assert.strictEqual(view.getUint16(endOffset + 20, true), 0); // no comment
  let count = view.getUint16(endOffset + 10, true);
  assert.strictEqual(view.getUint16(endOffset + 8, true), count);
  let centralSize = view.getUint32(endOffset + 12, true);
  let centralOffset = view.getUint32(endOffset + 16, true);

  const zip64 = endOffset >= 20 && view.getUint32(endOffset - 20, true) === 0x07064b50;
  if (zip64) {
    const locator = endOffset - 20;
    assert.strictEqual(view.getUint32(locator + 4, true), 0);
    assert.strictEqual(view.getUint32(locator + 16, true), 1);
    const record = Number(view.getBigUint64(locator + 8, true));
    assert.strictEqual(record, locator - 56);
    assert.strictEqual(view.getUint32(record, true), 0x06064b50);
    assert.strictEqual(Number(view.getBigUint64(record + 4, true)), 44);
    assert.strictEqual(view.getUint16(record + 14, true), 45);
    const count64 = Number(view.getBigUint64(record + 32, true));
    assert.strictEqual(Number(view.getBigUint64(record + 24, true)), count64);
    const size64 = Number(view.getBigUint64(record + 40, true));
    const offset64 = Number(view.getBigUint64(record + 48, true));
    // Classic fields either carry the real value or the "see ZIP64" marker.
    if (count !== 0xffff) assert.strictEqual(count, count64);
    if (centralSize !== 0xffffffff) assert.strictEqual(centralSize, size64);
    if (centralOffset !== 0xffffffff) assert.strictEqual(centralOffset, offset64);
    count = count64;
    centralSize = size64;
    centralOffset = offset64;
    assert.strictEqual(centralOffset + centralSize, record);
  } else {
    assert.ok(count < 0xffff);
    assert.strictEqual(centralOffset + centralSize, endOffset);
  }

  const entries: ParsedEntry[] = [];
  let position = centralOffset;
  let expectedLocalOffset = 0;
  for (let index = 0; index < count; index++) {
    assert.strictEqual(view.getUint32(position, true), 0x02014b50);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    assert.strictEqual(view.getUint16(position + 32, true), 0);
    const rawSize = view.getUint32(position + 24, true);
    const rawCompressed = view.getUint32(position + 20, true);
    const rawOffset = view.getUint32(position + 42, true);
    let size = rawSize;
    let offset = rawOffset;
    const overflow = [
      rawSize === 0xffffffff,
      rawCompressed === 0xffffffff,
      rawOffset === 0xffffffff,
    ];
    if (overflow.some(Boolean)) {
      const values = readZip64Extra(view, position + 46 + nameLength, extraLength, overflow);
      if (overflow[0]) size = values.shift()!;
      if (overflow[1]) assert.strictEqual(values.shift(), size);
      if (overflow[2]) offset = values.shift()!;
    } else {
      assert.strictEqual(extraLength, 0);
      assert.strictEqual(rawCompressed, rawSize);
    }
    const name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));
    const entry: ParsedEntry = {
      name,
      size,
      crc: view.getUint32(position + 16, true),
      flags: view.getUint16(position + 8, true),
      method: view.getUint16(position + 10, true),
      madeBy: view.getUint16(position + 4, true),
      versionNeeded: view.getUint16(position + 6, true),
      externalAttributes: view.getUint32(position + 38, true),
      dosTime: view.getUint16(position + 12, true),
      dosDate: view.getUint16(position + 14, true),
      offset,
      hasZip64Extra: overflow.some(Boolean),
      data: new Uint8Array(0),
    };

    // The local header must agree with the central directory.
    assert.strictEqual(offset, expectedLocalOffset);
    assert.strictEqual(view.getUint32(offset, true), 0x04034b50);
    assert.strictEqual(view.getUint16(offset + 6, true), entry.flags);
    assert.strictEqual(view.getUint16(offset + 8, true), entry.method);
    assert.strictEqual(view.getUint16(offset + 10, true), entry.dosTime);
    assert.strictEqual(view.getUint16(offset + 12, true), entry.dosDate);
    assert.strictEqual(view.getUint32(offset + 14, true), entry.crc);
    const localNameLength = view.getUint16(offset + 26, true);
    const localExtraLength = view.getUint16(offset + 28, true);
    assert.strictEqual(
      decoder.decode(bytes.subarray(offset + 30, offset + 30 + localNameLength)),
      name,
    );
    const localRawSize = view.getUint32(offset + 22, true);
    if (localRawSize === 0xffffffff) {
      assert.strictEqual(view.getUint32(offset + 18, true), 0xffffffff);
      const values = readZip64Extra(view, offset + 30 + localNameLength, localExtraLength, [
        true,
        true,
      ]);
      assert.deepStrictEqual(values, [size, size]);
    } else {
      assert.strictEqual(localRawSize, size);
      assert.strictEqual(view.getUint32(offset + 18, true), size);
      assert.strictEqual(localExtraLength, 0);
    }
    const dataStart = offset + 30 + localNameLength + localExtraLength;
    entry.data = bytes.subarray(dataStart, dataStart + size);
    expectedLocalOffset = dataStart + size;

    entries.push(entry);
    position += 46 + nameLength + extraLength;
  }
  assert.strictEqual(position, centralOffset + centralSize);
  assert.strictEqual(expectedLocalOffset, centralOffset);
  return { entries, zip64 };
}

// --- External tools -----------------------------------------------------------------------------

const hasPython = spawnSync('python3', ['--version']).status === 0;
const hasUnzip = spawnSync('unzip', ['-v']).status === 0;
const hasUtf8Locale =
  hasUnzip && spawnSync('locale', ['-a']).stdout?.toString().toLowerCase().includes('c.utf');

const workDir = mkdtempSync(join(tmpdir(), 'pdfkey-zip-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let fileCounter = 0;
async function writeToDisk(zip: Blob): Promise<string> {
  const path = join(workDir, `archive-${fileCounter++}.zip`);
  await pipeline(Readable.fromWeb(zip.stream() as never), createWriteStream(path));
  return path;
}

const PYTHON_LIST = `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    out = []
    for info in z.infolist():
        digest = hashlib.sha256()
        with z.open(info) as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                digest.update(chunk)
        out.append({
            'name': info.filename, 'size': info.file_size, 'compressed': info.compress_size,
            'method': info.compress_type, 'utf8': bool(info.flag_bits & 0x800),
            'time': list(info.date_time), 'sha256': digest.hexdigest(),
            'system': info.create_system, 'mode': info.external_attr >> 16,
        })
    json.dump({'bad': bad, 'entries': out}, sys.stdout)
`;

/** Cheap variant for archives with very many entries: CRC check of everything, count, last name. */
const PYTHON_SUMMARY = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    names = z.namelist()
    print(z.testzip(), len(names), names[-1])
`;

interface PythonEntry {
  name: string;
  size: number;
  compressed: number;
  method: number;
  utf8: boolean;
  time: number[];
  sha256: string;
  system: number;
  mode: number;
}

function pythonList(path: string): { bad: string | null; entries: PythonEntry[] } {
  const output = execFileSync('python3', ['-c', PYTHON_LIST, path], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(output.toString()) as { bad: string | null; entries: PythonEntry[] };
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function sampleFiles(): { files: OutputFile[]; contents: Buffer[] } {
  const contents = [randomBytes(100_000), randomBytes(12_345), Buffer.alloc(0), randomBytes(7)];
  const files: OutputFile[] = [
    { name: 'report_unlocked.pdf', blob: new Blob([contents[0]!], { type: 'application/pdf' }) },
    {
      name: '报告（最终版）.pdf',
      blob: new File([contents[1]!], 'ignored.pdf', {
        lastModified: new Date(2024, 1, 29, 12, 34, 56).getTime(),
      }),
    },
    { name: 'empty.pdf', blob: new Blob([]) },
    { name: 'Ünïcödé 😀.pdf', blob: new Blob([contents[3]!]) },
  ];
  return { files, contents };
}

// --- Tests --------------------------------------------------------------------------------------

describe('createZip', () => {
  it('produces a well-formed archive that round-trips', async () => {
    const { files, contents } = sampleFiles();
    const zip = await createZip(files);
    expect(zip.type).toBe('application/zip');

    const parsed = await parseZip(zip);
    expect(parsed.zip64).toBe(false);
    expect(parsed.entries.map((entry) => entry.name)).toEqual(files.map((file) => file.name));
    parsed.entries.forEach((entry, index) => {
      expect(entry.method).toBe(0);
      expect(entry.flags).toBe(0x0800);
      expect(entry.versionNeeded).toBe(20);
      expect(entry.madeBy).toBe((3 << 8) | 20);
      expect(entry.externalAttributes >>> 16).toBe(0o100644);
      expect(entry.hasZip64Extra).toBe(false);
      expect(entry.size).toBe(contents[index]!.length);
      expect(entry.crc).toBe(zlibCrc32(contents[index]!));
      expect(Buffer.compare(entry.data, contents[index]!)).toBe(0);
    });
  });

  it('adds nothing but headers to the file data', async () => {
    const { files } = sampleFiles();
    const zip = await createZip(files);
    const names = files.map((file) => new TextEncoder().encode(file.name).length);
    const overhead = names.reduce((sum, length) => sum + 30 + 46 + 2 * length, 22);
    expect(zip.size).toBe(files.reduce((sum, file) => sum + file.blob.size, overhead));
  });

  it('writes an empty archive for no files', async () => {
    const zip = await createZip([]);
    expect(zip.size).toBe(22);
    expect((await parseZip(zip)).entries).toEqual([]);
  });

  it('uses the modification time of File objects and "now" otherwise', async () => {
    const { files } = sampleFiles();
    const now = new Date(2031, 6, 4, 9, 8, 7);
    const parsed = await parseZip(await buildZip(files, { now }));
    expect(parsed.entries[0]).toMatchObject(toDosDateTime(now));
    expect(parsed.entries[1]).toMatchObject(toDosDateTime(new Date(2024, 1, 29, 12, 34, 56)));
  });

  it('sanitises names and makes them unique', async () => {
    const zip = await createZip([
      { name: 'a.pdf', blob: new Blob(['1']) },
      { name: 'A.pdf', blob: new Blob(['2']) },
      { name: '../../etc/x.pdf', blob: new Blob(['3']) },
      { name: 'dir\\file?.pdf', blob: new Blob(['4']) },
      { name: '', blob: new Blob(['5']) },
    ]);
    const names = (await parseZip(zip)).entries.map((entry) => entry.name);
    expect(names).toEqual(['a.pdf', 'A (2).pdf', '_.._etc_x.pdf', 'dir_file_.pdf', 'document']);
  });

  it('reads the files in chunks instead of loading them whole', async () => {
    const data = randomBytes(9 * 1024 * 1024);
    const blob = new Blob([data]);
    let whole = 0;
    let largestSlice = 0;
    blob.arrayBuffer = () => {
      whole++;
      return Promise.reject(new Error('must not read the whole blob'));
    };
    const slice = blob.slice.bind(blob);
    blob.slice = (start?: number, end?: number, type?: string) => {
      largestSlice = Math.max(largestSlice, (end ?? blob.size) - (start ?? 0));
      return slice(start, end, type);
    };
    const zip = await createZip([{ name: 'big.pdf', blob }]);
    expect(whole).toBe(0);
    expect(largestSlice).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(zip.size).toBe(data.length + 30 + 46 + 22 + 2 * 'big.pdf'.length);
  });

  it.runIf(hasPython)('is accepted by Python zipfile', async () => {
    const { files, contents } = sampleFiles();
    const listing = pythonList(await writeToDisk(await createZip(files)));
    expect(listing.bad).toBeNull();
    expect(listing.entries.map((entry) => entry.name)).toEqual(files.map((file) => file.name));
    listing.entries.forEach((entry, index) => {
      expect(entry.size).toBe(contents[index]!.length);
      expect(entry.compressed).toBe(entry.size);
      expect(entry.method).toBe(0);
      expect(entry.utf8).toBe(true);
      expect(entry.system).toBe(3);
      expect(entry.mode).toBe(0o100644);
      expect(entry.sha256).toBe(sha256(contents[index]!));
    });
    expect(listing.entries[1]!.time).toEqual([2024, 2, 29, 12, 34, 56]);
  });

  it.runIf(hasUnzip)('passes unzip -t', async () => {
    const { files } = sampleFiles();
    const path = await writeToDisk(await createZip(files));
    const result = spawnSync('unzip', ['-t', path]);
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain('No errors detected');
  });

  it.runIf(hasUtf8Locale)('extracts with the right names under a UTF-8 locale', async () => {
    const { files, contents } = sampleFiles();
    for (const options of [{}, { forceZip64: true }]) {
      const path = await writeToDisk(await buildZip(files, options));
      const target = mkdtempSync(join(workDir, 'extract-'));
      const result = spawnSync('unzip', ['-q', path, '-d', target], {
        env: { ...process.env, LC_ALL: 'C.UTF-8' },
      });
      expect(result.status).toBe(0);
      expect(readdirSync(target).sort()).toEqual(files.map((file) => file.name).sort());
      const listing = spawnSync('sha256sum', [join(target, files[0]!.name)]).stdout.toString();
      expect(listing.startsWith(sha256(contents[0]!))).toBe(true);
    }
  });
});

describe('ZIP64', () => {
  it('writes consistent ZIP64 structures when forced', async () => {
    const { files, contents } = sampleFiles();
    const zip = await buildZip(files, { forceZip64: true });
    const parsed = await parseZip(zip);
    expect(parsed.zip64).toBe(true);
    parsed.entries.forEach((entry, index) => {
      expect(entry.hasZip64Extra).toBe(true);
      expect(entry.versionNeeded).toBe(45);
      expect(entry.size).toBe(contents[index]!.length);
      expect(Buffer.compare(entry.data, contents[index]!)).toBe(0);
    });
  });

  it.runIf(hasPython && hasUnzip)(
    'forced ZIP64 archives are accepted by Python and unzip',
    async () => {
      const { files, contents } = sampleFiles();
      const path = await writeToDisk(await buildZip(files, { forceZip64: true }));
      const listing = pythonList(path);
      expect(listing.bad).toBeNull();
      expect(listing.entries.map((entry) => entry.sha256)).toEqual(contents.map(sha256));
      expect(listing.entries.map((entry) => entry.name)).toEqual(files.map((file) => file.name));
      expect(spawnSync('unzip', ['-t', path]).status).toBe(0);
    },
  );

  it('switches to ZIP64 for more than 65534 entries', async () => {
    const count = 65_536;
    const shared = new Blob(['%PDF-']);
    const files: OutputFile[] = Array.from({ length: count }, (_, index) => ({
      name: `f${index}.pdf`,
      blob: index % 2 ? shared : new Blob([String(index)]),
    }));
    const zip = await createZip(files);
    const parsed = await parseZip(zip);
    expect(parsed.zip64).toBe(true);
    expect(parsed.entries.length).toBe(count);
    // Nothing overflows per entry, so entries stay classic.
    expect(parsed.entries.every((entry) => !entry.hasZip64Extra)).toBe(true);
    expect(parsed.entries[65_534]!.name).toBe('f65534.pdf');
    expect(new TextDecoder().decode(parsed.entries[65_534]!.data)).toBe('65534');

    const path = await writeToDisk(zip);
    if (hasPython) {
      const summary = execFileSync('python3', ['-c', PYTHON_SUMMARY, path]).toString().trim();
      expect(summary).toBe(`None ${count} f${count - 1}.pdf`);
    }
    if (hasUnzip) {
      expect(spawnSync('unzip', ['-tq', path]).status).toBe(0);
    }
  });

  it('stays classic at exactly 65534 entries', async () => {
    const shared = new Blob(['x']);
    const files = Array.from({ length: 65_534 }, (_, index) => ({
      name: `${index}.pdf`,
      blob: shared,
    }));
    const zip = await createZip(files);
    const view = new DataView(await zip.slice(zip.size - 42).arrayBuffer());
    expect(view.getUint32(20, true)).toBe(0x06054b50);
    expect(view.getUint16(30, true)).toBe(65_534);
    expect(view.getUint32(0, true)).not.toBe(0x07064b50);
  });

  // Needs ~4.3 GiB of free disk space and about a minute:
  //   PDFKEY_TEST_HUGE_ZIP=1 npx vitest run src/lib/zip.test.ts
  // Node cannot slice Blobs beyond 4 GiB, so the big file is a stand-in that produces its content
  // on demand; the archive is assembled on disk from the parts instead of through `new Blob()`.
  it.runIf(process.env.PDFKEY_TEST_HUGE_ZIP === '1' && hasPython && hasUnzip)(
    'handles a file and offsets beyond 4 GiB',
    async () => {
      const block = randomBytes(64 * 1024 * 1024);
      const hugeSize = 65 * block.length + 12_345;
      expect(hugeSize).toBeGreaterThan(0xffffffff);
      const contentAt = (start: number, end: number): Buffer<ArrayBuffer> => {
        const out = Buffer.allocUnsafe(end - start);
        for (let done = 0; done < out.length;) {
          const from = (start + done) % block.length;
          done += block.copy(out, done, from, Math.min(block.length, from + out.length - done));
        }
        return out;
      };
      const huge = {
        size: hugeSize,
        type: 'application/pdf',
        slice: (start = 0, end = hugeSize) => new Blob([contentAt(start, Math.min(end, hugeSize))]),
      } as unknown as Blob;

      const tail = randomBytes(1000);
      const files: OutputFile[] = [
        { name: 'small-before.pdf', blob: new Blob(['before']) },
        { name: '巨大.pdf', blob: huge },
        { name: 'small-after.pdf', blob: new Blob([tail]) },
      ];
      const parts = await zipParts(files);

      const path = join(workDir, 'huge.zip');
      async function* bytes(): AsyncGenerator<Uint8Array> {
        for (const part of parts) {
          if (part instanceof Uint8Array) yield part;
          else if (part === huge) {
            for (let offset = 0; offset < hugeSize; offset += 8 << 20) {
              yield contentAt(offset, Math.min(hugeSize, offset + (8 << 20)));
            }
          } else yield new Uint8Array(await part.arrayBuffer());
        }
      }
      await pipeline(Readable.from(bytes()), createWriteStream(path));

      const listing = pythonList(path);
      expect(listing.bad).toBeNull();
      expect(listing.entries.map((entry) => [entry.name, entry.size])).toEqual([
        ['small-before.pdf', 6],
        ['巨大.pdf', hugeSize],
        ['small-after.pdf', 1000],
      ]);
      const expected = createHash('sha256');
      for (let i = 0; i < 65; i++) expected.update(block);
      expected.update(block.subarray(0, 12_345));
      expect(listing.entries[1]!.sha256).toBe(expected.digest('hex'));
      expect(listing.entries[2]!.sha256).toBe(sha256(tail));

      const test = spawnSync('unzip', ['-t', path]);
      expect(test.stdout.toString()).toContain('No errors detected');
      expect(test.status).toBe(0);
    },
    600_000,
  );
});

describe('toDosDateTime', () => {
  it('encodes local time with two-second resolution', () => {
    const { dosTime, dosDate } = toDosDateTime(new Date(2024, 1, 29, 23, 59, 59));
    expect(dosDate).toBe(((2024 - 1980) << 9) | (2 << 5) | 29);
    expect(dosTime).toBe((23 << 11) | (59 << 5) | 29);
  });

  it('clamps dates outside the representable range', () => {
    expect(toDosDateTime(new Date(1970, 0, 1))).toEqual({ dosTime: 0, dosDate: (1 << 5) | 1 });
    expect(toDosDateTime(new Date(Number.NaN))).toEqual({ dosTime: 0, dosDate: (1 << 5) | 1 });
    expect(toDosDateTime(new Date(2200, 0, 1)).dosDate).toBe((127 << 9) | (12 << 5) | 31);
  });
});
