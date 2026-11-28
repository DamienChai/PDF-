/**
 * Tests of the WebAssembly core below the public API: the block cache and the sink under hostile
 * settings, I/O failures at every point, and how much of a file is actually read.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import {
  ChunkSource,
  MemorySource,
  PdfxCore,
  type ByteSink,
  type ByteSource,
  type IoTuning,
  type RawProcessSpec,
} from './core';
import { openCandidates } from './passwords';
import { containsStreams, fixture, fixtureBytes, okFixtures, type OkFixture } from './test-support';
import { ALL_PERMISSIONS, PdfEngineError } from './types';

let core: PdfxCore;

beforeAll(async () => {
  core = await PdfxCore.create();
});

class CollectingSink implements ByteSink {
  readonly chunks: Uint8Array[] = [];

  write(chunk: Uint8Array): void {
    this.chunks.push(chunk.slice());
  }

  bytes(): Uint8Array {
    return new ChunkSource(this.chunks).read(0, this.size);
  }

  get size(): number {
    return this.chunks.reduce((total, chunk) => total + chunk.length, 0);
  }
}

/** Counts reads and can be told to fail from the n-th read on. */
class ProbeSource implements ByteSource {
  readonly size: number;
  reads = 0;
  failFrom = Infinity;
  shortFrom = Infinity;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.size = bytes.length;
  }

  read(offset: number, length: number): Uint8Array {
    this.reads++;
    if (this.reads >= this.failFrom) {
      throw new DOMException('The file could not be read', 'NotReadableError');
    }
    if (this.reads >= this.shortFrom) {
      return this.bytes.subarray(offset, offset + length - 1);
    }
    return this.bytes.subarray(offset, offset + length);
  }
}

const DECRYPT: RawProcessSpec = { operation: 'decrypt', streams: 'preserve', linearize: false };

function encryptSpec(user: string, owner: string): RawProcessSpec {
  const encoder = new TextEncoder();
  return {
    operation: 'encrypt',
    streams: 'preserve',
    linearize: false,
    encrypt: {
      algorithm: 'aes-256',
      user: encoder.encode(user),
      owner: encoder.encode(owner),
      permissions: { ...ALL_PERMISSIONS },
      encryptMetadata: true,
    },
  };
}

function candidates(f: OkFixture): Uint8Array[] {
  const password = f.userPassword ?? f.ownerPassword ?? '';
  return f.encryption ? openCandidates(password, f.encryption.revision) : [];
}

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfEngineError);
    return (error as PdfEngineError).code;
  }
  return 'no error';
}

/** A PDF with `streams` uncompressed streams of `streamBytes` pseudo-random bytes, one per page. */
function syntheticPdf(streams: number, streamBytes: number): Uint8Array {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let position = 0;
  const encoder = new TextEncoder();
  const push = (data: Uint8Array | string): void => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    parts.push(bytes);
    position += bytes.length;
  };
  const object = (body: string, stream?: Uint8Array): void => {
    offsets.push(position);
    push(`${offsets.length} 0 obj\n${body}\n`);
    if (stream) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };
  push('%PDF-1.4\n');
  const kids = Array.from({ length: streams }, (_, i) => `${3 + 2 * i} 0 R`).join(' ');
  object('<< /Type /Catalog /Pages 2 0 R >>');
  object(`<< /Type /Pages /Count ${streams} /Kids [ ${kids} ] >>`);
  let seed = 0x2545f491;
  for (let i = 0; i < streams; i++) {
    const data = new Uint8Array(streamBytes);
    for (let j = 0; j < data.length; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[j] = seed >>> 24;
    }
    object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents ${4 + 2 * i} 0 R >>`);
    object(`<< /Length ${streamBytes} >>`, data);
  }
  const xref = position;
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) {
    push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new ChunkSource(parts).read(0, position);
}

describe('version', () => {
  test('qpdf version', () => {
    expect(core.qpdfVersion).toBe('12.4.2');
  });
});

// Settings that turn the small fixtures into a workout for the cache: blocks far smaller than
// any object, room for only a handful of them, and (second set) multi-block read-ahead.
const hostileTunings: [string, IoTuning][] = [
  ['64-byte blocks, 4 slots', { blockBytes: 64, cacheBytes: 256, maxReadBytes: 64, sinkBytes: 16 }],
  [
    '96-byte blocks, read-ahead 8',
    { blockBytes: 96, cacheBytes: 96 * 32, maxReadBytes: 96 * 8, sinkBytes: 100 },
  ],
  [
    'one-block cache per megabyte',
    { blockBytes: 1 << 20, cacheBytes: 1 << 20, maxReadBytes: 1 << 20 },
  ],
];

describe.each(hostileTunings)('block cache: %s', (_name, tuning) => {
  test.each(okFixtures)('$file reads the same as with the defaults', (f) => {
    const bytes = fixtureBytes(f.file);
    const reference = core.inspect(new MemorySource(bytes), candidates(f));
    const probed = core.inspect(new MemorySource(bytes), candidates(f), tuning);
    expect({ ...probed, stats: null }).toEqual({ ...reference, stats: null });
    if ((tuning.blockBytes ?? 0) < 1024) {
      expect(probed.stats.readCalls).toBeGreaterThan(reference.stats.readCalls);
    }

    if (f.encrypted) {
      const sink = new CollectingSink();
      const result = core.process(
        new MemorySource(bytes),
        candidates(f),
        DECRYPT,
        sink,
        undefined,
        tuning,
      );
      expect(result.outputSize).toBe(sink.size);
      expect(result.pageCount).toBe(f.pageCount);
      expect(containsStreams(sink.bytes(), f.pageContentSha256)).toBe(true);
      expect(containsStreams(sink.bytes(), Object.values(f.attachmentSha256))).toBe(true);
      const reopened = core.inspect(new ChunkSource(sink.chunks), [], tuning);
      expect(reopened.encrypted).toBe(false);
      expect(reopened.pageCount).toBe(f.pageCount);
    }
  });
});

describe('block cache behaviour', () => {
  test('a tiny cache evicts, and the output is still right', () => {
    const f = fixture('aes-256-r6.pdf');
    const tuning: IoTuning = { blockBytes: 64, cacheBytes: 256, maxReadBytes: 64 };
    const result = core.process(
      new MemorySource(fixtureBytes(f.file)),
      candidates(f),
      DECRYPT,
      new CollectingSink(),
      undefined,
      tuning,
    );
    expect(result.stats.evictions).toBeGreaterThan(50);
    expect(result.stats.bytesRead).toBeGreaterThan(f.size);
  });

  test('a file that fits the cache is read at most once', () => {
    for (const f of okFixtures) {
      const result = core.inspect(new MemorySource(fixtureBytes(f.file)), candidates(f));
      expect(result.stats.bytesRead).toBeLessThanOrEqual(f.size);
      expect(result.stats.evictions).toBe(0);
    }
  });

  test('inspecting a large file reads a small part of it', () => {
    const pdf = syntheticPdf(24, 512 * 1024); // 12 MiB
    const source = new ProbeSource(pdf);
    const result = core.inspect(source, []);
    expect(result.pageCount).toBe(24);
    expect(result.stats.bytesRead).toBeLessThan(pdf.length / 4);
    expect(result.stats.readCalls).toBe(source.reads);
    expect(source.reads).toBeLessThan(80);
  });

  test('sequential copying uses few, large reads and a bounded cache', () => {
    const pdf = syntheticPdf(24, 512 * 1024);
    const encrypted = new CollectingSink();
    core.process(new MemorySource(pdf), [], encryptSpec('u', 'o'), encrypted);

    const source = new ProbeSource(encrypted.bytes());
    const tuning: IoTuning = { cacheBytes: 4 * 1024 * 1024, maxReadBytes: 1024 * 1024 };
    const sink = new CollectingSink();
    const result = core.process(
      source,
      [new TextEncoder().encode('u')],
      DECRYPT,
      sink,
      undefined,
      tuning,
    );
    expect(result.pageCount).toBe(24);
    expect(sink.size).toBeGreaterThan(12 * 1024 * 1024);
    // 12 MiB through a cache a fraction of that size: blocks are evicted, yet nothing is read
    // much more than once and the reads are big (a perfect scan would need 3 reads of 4 MiB;
    // qpdf first visits every object once, which costs one small read per stream here).
    expect(result.stats.evictions).toBeGreaterThan(0);
    expect(result.stats.bytesRead).toBeLessThan(source.size * 1.25);
    expect(result.stats.readCalls).toBeLessThan(60);
    const reopened = core.inspect(new ChunkSource(sink.chunks), []);
    expect(reopened.encrypted).toBe(false);
    expect(reopened.pageCount).toBe(24);
  });
});

describe('I/O failures', () => {
  test('a read failure at any point is reported as read-failed', () => {
    const f = fixture('objstm-r6.pdf');
    const bytes = fixtureBytes(f.file);
    const tuning: IoTuning = {
      blockBytes: 128,
      cacheBytes: 1024,
      maxReadBytes: 128,
      sinkBytes: 64,
    };
    const clean = new ProbeSource(bytes);
    core.process(clean, candidates(f), DECRYPT, new CollectingSink(), undefined, tuning);
    expect(clean.reads).toBeGreaterThan(40);

    for (let failFrom = 1; failFrom <= clean.reads; failFrom++) {
      const source = new ProbeSource(bytes);
      source.failFrom = failFrom;
      let caught: PdfEngineError | undefined;
      try {
        core.process(source, candidates(f), DECRYPT, new CollectingSink(), undefined, tuning);
      } catch (error) {
        caught = error as PdfEngineError;
      }
      expect(caught, `failing read ${failFrom}`).toBeInstanceOf(PdfEngineError);
      expect(caught!.code, `failing read ${failFrom}`).toBe('read-failed');
      expect(caught!.detail).toContain('NotReadableError');
      expect(core.usable).toBe(true);
    }
    // Still fine afterwards.
    expect(core.inspect(new MemorySource(bytes), candidates(f)).pageCount).toBe(f.pageCount);
  });

  test('a read failure while recovering a damaged file is still read-failed', () => {
    const bytes = fixtureBytes('damaged-recoverable.pdf');
    const tuning: IoTuning = { blockBytes: 256, cacheBytes: 1024, maxReadBytes: 256 };
    const clean = new ProbeSource(bytes);
    core.inspect(clean, [], tuning);
    for (let failFrom = 1; failFrom <= clean.reads; failFrom += 3) {
      const source = new ProbeSource(bytes);
      source.failFrom = failFrom;
      expect(
        errorCode(() => core.inspect(source, [], tuning)),
        `failing read ${failFrom}`,
      ).toBe('read-failed');
    }
  });

  test('a short read is a failure', () => {
    const source = new ProbeSource(fixtureBytes('plain.pdf'));
    source.shortFrom = 1;
    expect(errorCode(() => core.inspect(source, []))).toBe('read-failed');
  });

  test('a sink that cannot take a chunk', () => {
    const f = fixture('aes-128-r4.pdf');
    const source = new MemorySource(fixtureBytes(f.file));
    const failing = (error: Error, after: number): ByteSink => {
      let writes = 0;
      return {
        write() {
          if (++writes > after) {
            throw error;
          }
        },
      };
    };
    const tuning: IoTuning = { sinkBytes: 256 };
    for (const after of [0, 1, 5]) {
      expect(
        errorCode(() =>
          core.process(
            source,
            candidates(f),
            DECRYPT,
            failing(new Error('disk full'), after),
            undefined,
            tuning,
          ),
        ),
      ).toBe('internal');
      expect(
        errorCode(() =>
          core.process(
            source,
            candidates(f),
            DECRYPT,
            failing(new RangeError('Array buffer allocation failed'), after),
            undefined,
            tuning,
          ),
        ),
      ).toBe('out-of-memory');
    }
    expect(core.usable).toBe(true);
    expect(core.process(source, candidates(f), DECRYPT, new CollectingSink()).pageCount).toBe(
      f.pageCount,
    );
  });

  test('a progress listener that throws is ignored', () => {
    const f = fixture('aes-128-r4.pdf');
    const result = core.process(
      new MemorySource(fixtureBytes(f.file)),
      candidates(f),
      DECRYPT,
      new CollectingSink(),
      () => {
        throw new Error('listener bug');
      },
    );
    expect(result.pageCount).toBe(f.pageCount);
  });
});

describe('hostile input', () => {
  // A deterministic slice of the mutation fuzzing done during development (tens of thousands of
  // rounds without a trap). Whatever the bytes are, the answer is a result or a PdfEngineError,
  // never a crashed instance, and never one of the codes that mean "our fault".
  test('mutated fixtures never crash the instance', () => {
    let seed = 20261125;
    const random = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor((seed / 4294967296) * n);
    };
    const outcomes = new Map<string, number>();
    for (let round = 0; round < 400; round++) {
      const f = okFixtures[random(okFixtures.length)]!;
      const bytes = fixtureBytes(f.file).slice();
      let data = bytes;
      switch (random(5)) {
        case 0: // flip bytes
          for (let i = 0, n = 1 + random(8); i < n; i++) {
            bytes[random(bytes.length)] = random(256);
          }
          break;
        case 1: // truncate
          data = bytes.subarray(0, random(bytes.length));
          break;
        case 2: // overwrite a range
          bytes.fill(random(256), random(bytes.length), random(bytes.length));
          break;
        case 3: // move a range
          bytes.copyWithin(random(bytes.length), random(bytes.length), random(bytes.length));
          break;
        default: // change digits: offsets, lengths, object numbers
          for (let i = 0, n = 1 + random(6); i < n; i++) {
            let at = random(bytes.length);
            while (at < bytes.length && (bytes[at]! < 0x30 || bytes[at]! > 0x39)) {
              at++;
            }
            if (at < bytes.length) {
              bytes[at] = 0x30 + random(10);
            }
          }
      }
      const tuning: IoTuning | undefined =
        random(3) === 0
          ? { blockBytes: 64 << random(6), cacheBytes: 1024 << random(6), maxReadBytes: 4096 }
          : undefined;
      const spec: RawProcessSpec = {
        operation: 'decrypt',
        streams: random(2) ? 'compress' : 'preserve',
        linearize: random(2) === 1,
      };
      const code = errorCode(() =>
        core.process(
          new MemorySource(data),
          candidates(f),
          spec,
          new CollectingSink(),
          undefined,
          tuning,
        ),
      );
      outcomes.set(code, (outcomes.get(code) ?? 0) + 1);
      expect(core.usable, `round ${round}: ${f.file}`).toBe(true);
    }
    for (const unexpected of ['internal', 'out-of-memory', 'read-failed', 'engine-unavailable']) {
      expect(outcomes.get(unexpected), unexpected).toBeUndefined();
    }
    expect(outcomes.get('no error')).toBeGreaterThan(50);
    expect(outcomes.get('damaged')).toBeGreaterThan(10);
  });
});

describe('requests', () => {
  test('progress runs from low to 100 without going back', () => {
    const f = fixture('aes-256-r6.pdf');
    const seen: number[] = [];
    core.process(
      new MemorySource(fixtureBytes(f.file)),
      candidates(f),
      DECRYPT,
      new CollectingSink(),
      (percent) => seen.push(percent),
    );
    expect(seen.length).toBeGreaterThan(3);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[0]).toBeGreaterThanOrEqual(0);
    expect(seen.at(-1)).toBe(100);

    const linearized: number[] = [];
    core.process(
      new MemorySource(fixtureBytes(f.file)),
      candidates(f),
      { ...DECRYPT, linearize: true },
      new CollectingSink(),
      (percent) => linearized.push(percent),
    );
    expect(linearized).toEqual([...linearized].sort((a, b) => a - b));
    expect(linearized.at(-1)).toBe(100);
  });

  test('the index of the matching candidate is reported', () => {
    const f = fixture('aes-256-r6.pdf');
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    const source = new MemorySource(fixtureBytes(f.file));
    expect(core.inspect(source, []).matchedIndex).toBe(-1);
    expect(core.inspect(source, [encode('no'), encode('nope')]).matchedIndex).toBe(-1);
    expect(
      core.inspect(source, [encode('no'), encode('nope'), encode(f.userPassword!)]).matchedIndex,
    ).toBe(2);
    expect(core.inspect(source, [encode(f.ownerPassword!), encode(f.userPassword!)]).access).toBe(
      'owner',
    );
  });

  test('a malformed request is an internal error, not a crash', () => {
    const source = new MemorySource(fixtureBytes('plain.pdf'));
    const bogus = {
      operation: 'explode',
      streams: 'preserve',
      linearize: false,
    } as unknown as RawProcessSpec;
    expect(errorCode(() => core.process(source, [], bogus, new CollectingSink()))).toBe('internal');
    const noPasswords = {
      operation: 'encrypt',
      streams: 'preserve',
      linearize: false,
    } as RawProcessSpec;
    expect(errorCode(() => core.process(source, [], noPasswords, new CollectingSink()))).toBe(
      'internal',
    );
    expect(core.usable).toBe(true);
  });

  test('repeated work does not grow the heap', () => {
    const f = fixture('objstm-r4.pdf');
    const source = new MemorySource(fixtureBytes(f.file));
    const run = (): void => {
      core.process(source, candidates(f), DECRYPT, new CollectingSink());
      errorCode(() =>
        core.inspect(new MemorySource(fixtureBytes('damaged-unrecoverable.pdf')), []),
      );
      errorCode(() => core.process(source, [], DECRYPT, new CollectingSink()));
    };
    for (let i = 0; i < 20; i++) {
      run();
    }
    const before = core.heapBytes;
    for (let i = 0; i < 300; i++) {
      run();
    }
    expect(core.heapBytes).toBe(before);
  });

  test('independent instances do not share state', async () => {
    const other = await PdfxCore.create();
    const f = fixture('aes-256-r6.pdf');
    const a = core.inspect(new MemorySource(fixtureBytes(f.file)), candidates(f));
    const b = other.inspect(new MemorySource(fixtureBytes(f.file)), candidates(f));
    expect(b).toEqual(a);
  });
});
