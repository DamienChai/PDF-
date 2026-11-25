/**
 * A scripted stand-in for the PDF engine: for unit tests, and for reaching every state of the UI
 * by hand (`?fake` in a development build, see src/state/engine.ts).
 *
 * What a file "is" depends only on its name, see `FAKE_SCENARIOS`. Unknown names behave like
 * `plain.pdf`. Outputs of the fake are remembered, so inspecting or re-processing them is
 * consistent with what was asked for.
 *
 * Never part of a production build.
 */
import { checkNewPasswords } from '../../src/engine/passwords';
import {
  ALL_PERMISSIONS,
  PdfEngineError,
  type AccessLevel,
  type AlgorithmId,
  type CallOptions,
  type CipherMethod,
  type EncryptionInfo,
  type EngineErrorCode,
  type EngineInfo,
  type InspectResult,
  type Operation,
  type PdfEngine,
  type Permissions,
  type ProcessCallOptions,
  type ProcessRequest,
  type ProcessResult,
} from '../../src/engine/types';

/** Present in every build that contains the fake engine; `dist/` must not contain it. */
export const FAKE_ENGINE_MARKER = 'pdfkey-fake-engine-not-for-production';

// --- Scenarios ---------------------------------------------------------------------------------

export interface FakeEncryption {
  algorithm: AlgorithmId;
  keyBits: number;
  revision: number;
  /** `null`: the document opens without a password (restrictions only). */
  userPassword: string | null;
  ownerPassword: string;
  permissions: Permissions;
  encryptMetadata?: boolean;
}

export interface FakeFailure {
  code: EngineErrorCode;
  detail?: string;
}

export interface FakeScenario {
  /** `null`: not encrypted. */
  encryption: FakeEncryption | null;
  pages: number;
  pdfVersion: string;
  linearized?: boolean;
  /** Reported by inspect() and process(), like a repaired cross-reference table. */
  warnings?: string[];
  /** Size reported for the document in bytes. Default: the real size of the file. */
  size?: number;
  /** inspect() (and process()) reject with this. */
  inspectError?: FakeFailure;
  /** process() rejects with this after some progress. */
  processError?: FakeFailure;
  /** Processing takes this many times as long as a normal file. */
  slowness?: number;
}

const RESTRICTED: Permissions = {
  print: 'none',
  modify: false,
  extract: false,
  annotate: true,
  fillForms: true,
  assemble: false,
  accessibility: true,
};

function encrypted(
  algorithm: AlgorithmId,
  userPassword: string | null,
  ownerPassword: string,
  permissions: Permissions = { ...ALL_PERMISSIONS },
  keyBits?: number,
): FakeEncryption {
  const revision =
    algorithm === 'aes-256'
      ? 6
      : algorithm === 'aes-256-r5'
        ? 5
        : algorithm === 'aes-128'
          ? 4
          : keyBits === 40
            ? 2
            : 3;
  const bits = keyBits ?? (algorithm === 'aes-256' || algorithm === 'aes-256-r5' ? 256 : 128);
  return { algorithm, keyBits: bits, revision, userPassword, ownerPassword, permissions };
}

/** The password that opens every password-protected demo file. */
export const DEMO_PASSWORD = '1234';
/** The owner password of every demo file that has a separate one. */
export const DEMO_OWNER_PASSWORD = 'owner';

/**
 * Behaviour by file name.
 *
 * | name                         | behaviour                                                        |
 * | ---------------------------- | ---------------------------------------------------------------- |
 * | plain.pdf                    | not encrypted                                                    |
 * | needs-password.pdf           | AES-256; opens with "1234" (user) or "owner" (owner)             |
 * | 2024年度财务报表_最终版(3).pdf | same as needs-password.pdf, with a long name                     |
 * | same-password.pdf            | AES-256; "1234" is both user and owner password                  |
 * | owner-only.pdf               | AES-256; opens without a password, printing and copying denied   |
 * | owner-only-unrestricted.pdf  | AES-128; opens without a password, nothing restricted            |
 * | aes128.pdf                   | AES-128; "1234"                                                  |
 * | aes256-r5.pdf                | AES-256 with the deprecated R5 handler; "1234"                   |
 * | rc4.pdf                      | RC4 128-bit; "1234"                                              |
 * | rc4-40.pdf                   | RC4 40-bit; "1234"; low-resolution printing only                 |
 * | repaired.pdf                 | AES-256; "1234"; reports warnings                                |
 * | slow.pdf                     | restrictions only; processing takes several seconds              |
 * | huge.pdf                     | AES-256; "1234"; reports 1.8 GB and 2,340 pages                  |
 * | damaged.pdf                  | inspect fails: damaged                                           |
 * | unsupported.pdf              | inspect fails: unsupported-encryption                            |
 * | not-a-pdf.pdf                | inspect fails: not-pdf (the demo file has no %PDF- header)       |
 * | engine-unavailable.pdf       | inspect fails: engine-unavailable                                |
 * | read-failed.pdf              | restrictions only; processing fails: read-failed                 |
 * | out-of-memory.pdf            | restrictions only; processing fails: out-of-memory               |
 * | crash.pdf                    | not encrypted; processing (locking) fails: internal              |
 */
export const FAKE_SCENARIOS: Readonly<Record<string, FakeScenario>> = {
  'plain.pdf': { encryption: null, pages: 12, pdfVersion: '1.7' },
  'needs-password.pdf': {
    encryption: encrypted('aes-256', DEMO_PASSWORD, DEMO_OWNER_PASSWORD, RESTRICTED),
    pages: 4,
    pdfVersion: '2.0',
  },
  '2024年度财务报表_最终版(3).pdf': {
    encryption: encrypted('aes-256', DEMO_PASSWORD, DEMO_OWNER_PASSWORD, RESTRICTED),
    pages: 86,
    pdfVersion: '1.7',
  },
  'same-password.pdf': {
    encryption: encrypted('aes-256', DEMO_PASSWORD, DEMO_PASSWORD),
    pages: 2,
    pdfVersion: '2.0',
  },
  'owner-only.pdf': {
    encryption: encrypted('aes-256', null, DEMO_OWNER_PASSWORD, {
      ...ALL_PERMISSIONS,
      print: 'none',
      extract: false,
    }),
    pages: 31,
    pdfVersion: '1.7',
  },
  'owner-only-unrestricted.pdf': {
    encryption: encrypted('aes-128', null, DEMO_OWNER_PASSWORD),
    pages: 3,
    pdfVersion: '1.6',
  },
  'aes128.pdf': {
    encryption: encrypted('aes-128', DEMO_PASSWORD, DEMO_OWNER_PASSWORD),
    pages: 8,
    pdfVersion: '1.6',
  },
  'aes256-r5.pdf': {
    encryption: encrypted('aes-256-r5', DEMO_PASSWORD, DEMO_OWNER_PASSWORD),
    pages: 5,
    pdfVersion: '1.7',
  },
  'rc4.pdf': {
    encryption: encrypted('rc4', DEMO_PASSWORD, DEMO_OWNER_PASSWORD, RESTRICTED, 128),
    pages: 17,
    pdfVersion: '1.4',
  },
  'rc4-40.pdf': {
    encryption: encrypted(
      'rc4',
      DEMO_PASSWORD,
      DEMO_OWNER_PASSWORD,
      { ...ALL_PERMISSIONS, print: 'low', modify: false },
      40,
    ),
    pages: 1,
    pdfVersion: '1.3',
  },
  'repaired.pdf': {
    encryption: encrypted('aes-256', DEMO_PASSWORD, DEMO_OWNER_PASSWORD),
    pages: 9,
    pdfVersion: '1.7',
    warnings: [
      'file is damaged',
      "can't find startxref",
      'Attempting to reconstruct cross-reference table',
    ],
  },
  'slow.pdf': {
    encryption: encrypted('aes-256', null, DEMO_OWNER_PASSWORD, RESTRICTED),
    pages: 640,
    pdfVersion: '1.7',
    slowness: 8,
  },
  'huge.pdf': {
    encryption: encrypted('aes-256', DEMO_PASSWORD, DEMO_OWNER_PASSWORD),
    pages: 2340,
    pdfVersion: '1.7',
    size: 1_932_735_283,
    slowness: 3,
  },
  'damaged.pdf': {
    encryption: null,
    pages: 0,
    pdfVersion: '1.4',
    inspectError: {
      code: 'damaged',
      detail: 'damaged.pdf: unable to find trailer dictionary while recovering damaged file',
    },
  },
  'unsupported.pdf': {
    encryption: null,
    pages: 0,
    pdfVersion: '1.6',
    inspectError: {
      code: 'unsupported-encryption',
      detail: 'unsupported.pdf: unsupported security handler /Adobe.PubSec',
    },
  },
  'not-a-pdf.pdf': {
    encryption: null,
    pages: 0,
    pdfVersion: '',
    inspectError: { code: 'not-pdf', detail: 'not-a-pdf.pdf: not a PDF file' },
  },
  'engine-unavailable.pdf': {
    encryption: null,
    pages: 0,
    pdfVersion: '',
    inspectError: { code: 'engine-unavailable', detail: 'failed to fetch pdfx.wasm' },
  },
  'read-failed.pdf': {
    encryption: encrypted('aes-256', null, DEMO_OWNER_PASSWORD, RESTRICTED),
    pages: 6,
    pdfVersion: '1.7',
    processError: {
      code: 'read-failed',
      detail: 'NotFoundError: A requested file or directory could not be found',
    },
  },
  'out-of-memory.pdf': {
    encryption: encrypted('aes-256', null, DEMO_OWNER_PASSWORD, RESTRICTED),
    pages: 4100,
    pdfVersion: '1.7',
    processError: { code: 'out-of-memory', detail: 'memory allocation of 268435456 bytes failed' },
  },
  'crash.pdf': {
    encryption: null,
    pages: 7,
    pdfVersion: '1.7',
    processError: { code: 'internal', detail: 'the engine worker crashed: RuntimeError' },
  },
};

/** Real sizes of the demo files (they are padded up to this many bytes). */
const DEMO_SIZES: Readonly<Record<string, number>> = {
  'plain.pdf': 482_113,
  'needs-password.pdf': 1_288_490,
  '2024年度财务报表_最终版(3).pdf': 3_874_201,
  'same-password.pdf': 86_420,
  'owner-only.pdf': 2_411_724,
  'owner-only-unrestricted.pdf': 151_300,
  'aes128.pdf': 734_003,
  'aes256-r5.pdf': 512_877,
  'rc4.pdf': 964_112,
  'rc4-40.pdf': 48_230,
  'repaired.pdf': 1_020_554,
  'slow.pdf': 8_388_608,
  'damaged.pdf': 700,
  'unsupported.pdf': 233_015,
  'not-a-pdf.pdf': 18_452,
  'engine-unavailable.pdf': 120_000,
  'read-failed.pdf': 310_022,
  'out-of-memory.pdf': 6_291_456,
  'crash.pdf': 402_118,
};

export const DEMO_FILE_NAMES: readonly string[] = Object.keys(FAKE_SCENARIOS);

// --- Demo files --------------------------------------------------------------------------------

/**
 * A valid one-page PDF showing `label` (ASCII only), as the parts of a Blob. `padding` bytes are
 * added inside a comment line, which brings a demo file to a realistic size without building a
 * large string.
 */
function minimalPdf(label: string, padding = 0): BlobPart[] {
  const text = label.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, '\\$&');
  const content = `BT /F1 16 Tf 56 780 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  // The padding follows this "%": everything up to the next line break is a comment.
  const intro = `%PDF-1.7\n% ${FAKE_ENGINE_MARKER}\n%`;
  const start = intro.length + padding;
  let body = '\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(start + body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = start + body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return padding > 0 ? [intro, new Uint8Array(padding), body] : [intro + body];
}

function byteLength(parts: readonly BlobPart[]): number {
  return new Blob([...parts]).size;
}

export interface DemoFileOptions {
  /** Default: a fixed date, so that demo files are stable between runs. */
  lastModified?: number;
  /** Size in bytes. Default: the size listed for the demo file, or a few hundred bytes. */
  size?: number;
}

/** Largest demo file that is really allocated; anything bigger only *reports* its size. */
const MAX_REAL_BYTES = 16 * 1024 * 1024;

/**
 * A `File` for one of the names in `FAKE_SCENARIOS` (or any other name, which then behaves like
 * `plain.pdf`). Except for `not-a-pdf.pdf` it is a valid one-page PDF of the listed size.
 */
export function createDemoFile(name: string, options: DemoFileOptions = {}): File {
  const isPdf = name !== 'not-a-pdf.pdf';
  let parts: BlobPart[] = isPdf ? minimalPdf(name) : ['PK\u0003\u0004 this is not a PDF\n'];
  const smallest = byteLength(parts);
  const size = options.size ?? FAKE_SCENARIOS[name]?.size ?? DEMO_SIZES[name] ?? smallest;
  if (size > smallest && size <= MAX_REAL_BYTES) {
    if (isPdf) {
      // The padding moves the cross-reference table, whose offset is written in the file with
      // as many digits as it needs; a second pass corrects for the digits it gained.
      let padding = size - smallest;
      for (let pass = 0; pass < 4 && byteLength(parts) !== size; pass++) {
        parts = minimalPdf(name, padding);
        padding -= byteLength(parts) - size;
      }
    } else {
      parts = [...parts, new Uint8Array(size - smallest)];
    }
  }
  const file = new File(parts, name, {
    type: 'application/pdf',
    lastModified: options.lastModified ?? Date.UTC(2026, 2, 14, 9, 30),
  });
  if (file.size !== size) {
    // Too large to allocate (or smaller than a PDF can be): only the number is faked.
    Object.defineProperty(file, 'size', { value: size });
  }
  return file;
}

/** Demo files for the given names; all of them by default. */
export function createDemoFiles(names: readonly string[] = DEMO_FILE_NAMES): File[] {
  return names.map((name) => createDemoFile(name));
}

// --- Engine ------------------------------------------------------------------------------------

export interface FakeEngineOptions {
  /** How long inspect() takes. Default 0: answers after a microtask. */
  inspectDelayMs?: number;
  /** How long processing a normal file takes. Default 0. */
  processDelayMs?: number;
  /** Progress reports per job before the final 1. Default 8. */
  steps?: number;
  /**
   * Freezes jobs: a fraction in (0, 1) stops process() at that progress, `'inspect'` stops
   * inspect() before it answers. Frozen jobs continue after `release()` and end when aborted.
   */
  hold?: number | 'inspect' | null;
  /** Jobs running at the same time; the rest waits in order. Default 2. */
  concurrency?: number;
  /** Every call rejects with `engine-unavailable`. */
  unavailable?: boolean;
  mode?: EngineInfo['mode'];
  /** Additional or replacement scenarios by file name. */
  scenarios?: Record<string, FakeScenario>;
}

export interface FakeProcessCall {
  name: string;
  password: string;
  operation: Operation;
  output: ProcessRequest['output'];
}

export interface FakeEngine extends PdfEngine {
  /** Lets jobs frozen by `hold` continue and stops freezing new ones. */
  release(): void;
  /** Changes what `hold` freezes from now on. */
  setHold(hold: FakeEngineOptions['hold']): void;
  setUnavailable(unavailable: boolean): void;
  /** Number of jobs currently frozen by `hold`. */
  readonly held: number;
  /** What was asked of the engine, for assertions. */
  readonly calls: {
    ready: number;
    inspect: string[];
    process: FakeProcessCall[];
  };
  readonly disposed: boolean;
}

export const FAKE_QPDF_VERSION = '12.4.2-fake';

const DEFAULT_SCENARIO: FakeScenario = { encryption: null, pages: 1, pdfVersion: '1.7' };

function cancelled(): PdfEngineError {
  return new PdfEngineError('cancelled');
}

function cipherOf(algorithm: AlgorithmId): CipherMethod {
  if (algorithm === 'rc4') return 'rc4';
  if (algorithm === 'aes-128') return 'aesv2';
  return algorithm === 'unknown' ? 'unknown' : 'aesv3';
}

/** The `/P` value a writer would store for these permissions (ISO 32000-1, table 22). */
function rawPermissions(p: Permissions): number {
  let bits = 0xfffff0c0;
  if (p.print !== 'none') bits |= 1 << 2;
  if (p.modify) bits |= 1 << 3;
  if (p.extract) bits |= 1 << 4;
  if (p.annotate) bits |= 1 << 5;
  if (p.fillForms) bits |= 1 << 8;
  if (p.accessibility) bits |= 1 << 9;
  if (p.assemble) bits |= 1 << 10;
  if (p.print === 'full') bits |= 1 << 11;
  return bits | 0;
}

function encryptionInfo(e: FakeEncryption): EncryptionInfo {
  const method = cipherOf(e.algorithm);
  return {
    algorithm: e.algorithm,
    keyBits: e.keyBits,
    revision: e.revision,
    version: e.revision >= 5 ? 5 : e.revision === 4 ? 4 : e.keyBits === 40 ? 1 : 2,
    rawPermissions: rawPermissions(e.permissions),
    permissions: { ...e.permissions },
    streamMethod: method,
    stringMethod: method,
    fileMethod: method,
    encryptMetadata: e.encryptMetadata ?? true,
  };
}

function accessFor(scenario: FakeScenario, password: string): AccessLevel {
  const e = scenario.encryption;
  if (!e) return 'none';
  const isOwner = password !== '' && password === e.ownerPassword;
  if (e.userPassword === null) return isOwner ? 'owner' : 'user';
  const isUser = password !== '' && password === e.userPassword;
  if (isUser && isOwner) return 'both';
  if (isOwner) return 'owner';
  return isUser ? 'user' : 'locked';
}

export function createFakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  const inspectDelayMs = options.inspectDelayMs ?? 0;
  const processDelayMs = options.processDelayMs ?? 0;
  const steps = Math.max(1, Math.floor(options.steps ?? 8));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const scenarios: Record<string, FakeScenario> = { ...FAKE_SCENARIOS, ...options.scenarios };
  /** What the fake produced: inspecting an output tells the truth about it. */
  const outputs = new WeakMap<Blob, FakeScenario>();
  const calls: FakeEngine['calls'] = { ready: 0, inspect: [], process: [] };

  let hold = options.hold ?? null;
  let unavailable = options.unavailable ?? false;
  let disposed = false;
  let active = 0;
  const waiting: Array<() => void> = [];
  const frozen = new Set<() => void>();
  const disposal = new AbortController();

  function nameOf(file: Blob): string {
    return typeof (file as Partial<File>).name === 'string' ? (file as File).name : '';
  }

  function scenarioFor(file: Blob): FakeScenario {
    return outputs.get(file) ?? scenarios[nameOf(file)] ?? DEFAULT_SCENARIO;
  }

  function assertUsable(signal: AbortSignal | undefined): void {
    if (disposed) throw new PdfEngineError('cancelled', 'the engine was disposed');
    if (signal?.aborted) throw cancelled();
    if (unavailable) {
      throw new PdfEngineError('engine-unavailable', 'the fake engine was told to be unavailable');
    }
  }

  /** Resolves after `ms`, or after a microtask for 0; rejects as soon as the job is aborted. */
  function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted || disposed) return reject(cancelled());
      if (ms <= 0) return resolve();
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        disposal.signal.removeEventListener('abort', abort);
      };
      const abort = (): void => {
        finish();
        reject(cancelled());
      };
      const timer = setTimeout(() => {
        finish();
        resolve();
      }, ms);
      signal?.addEventListener('abort', abort, { once: true });
      disposal.signal.addEventListener('abort', abort, { once: true });
    });
  }

  /** Resolves when `release()` is called; rejects when the job is aborted. */
  function freeze(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted || disposed) return reject(cancelled());
      const finish = (): void => {
        frozen.delete(thaw);
        signal?.removeEventListener('abort', abort);
        disposal.signal.removeEventListener('abort', abort);
      };
      const thaw = (): void => {
        finish();
        resolve();
      };
      const abort = (): void => {
        finish();
        reject(cancelled());
      };
      frozen.add(thaw);
      signal?.addEventListener('abort', abort, { once: true });
      disposal.signal.addEventListener('abort', abort, { once: true });
    });
  }

  /** Waits for one of the `concurrency` places; returns the function that gives it back. */
  async function acquire(signal: AbortSignal | undefined): Promise<() => void> {
    const release = (): void => {
      const next = waiting.shift();
      if (next) next();
      else active--;
    };
    if (active < concurrency) {
      active++;
      return release;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        const index = waiting.indexOf(start);
        if (index >= 0) waiting.splice(index, 1);
        reject(cancelled());
      };
      const start = (): void => {
        signal?.removeEventListener('abort', abort);
        disposal.signal.removeEventListener('abort', abort);
        resolve();
      };
      waiting.push(start);
      signal?.addEventListener('abort', abort, { once: true });
      disposal.signal.addEventListener('abort', abort, { once: true });
    });
    return release;
  }

  function describe(scenario: FakeScenario, file: Blob, password: string): InspectResult {
    const access = accessFor(scenario, password);
    const locked = access === 'locked';
    return {
      fileSize: scenario.size ?? file.size,
      pdfVersion: scenario.pdfVersion || null,
      encrypted: scenario.encryption !== null,
      access,
      opensWithoutPassword: !scenario.encryption || scenario.encryption.userPassword === null,
      encryption: scenario.encryption ? encryptionInfo(scenario.encryption) : null,
      pageCount: locked ? null : scenario.pages,
      linearized: locked ? null : (scenario.linearized ?? false),
      warnings: [...(scenario.warnings ?? [])],
    };
  }

  function outputScenario(input: FakeScenario, request: ProcessRequest): FakeScenario {
    const base: FakeScenario = {
      encryption: null,
      pages: input.pages,
      pdfVersion: input.pdfVersion,
      linearized: request.output?.linearize ?? false,
    };
    if (request.operation.kind === 'decrypt') return base;
    const { algorithm, userPassword, ownerPassword, permissions, encryptMetadata } =
      request.operation.options;
    return {
      ...base,
      pdfVersion: algorithm === 'aes-256' ? '2.0' : '1.6',
      encryption: {
        algorithm,
        keyBits: algorithm === 'aes-256' ? 256 : 128,
        revision: algorithm === 'aes-256' ? 6 : 4,
        userPassword: userPassword === '' ? null : userPassword,
        ownerPassword: ownerPassword === '' ? userPassword : ownerPassword,
        permissions: { ...permissions, accessibility: true },
        encryptMetadata,
      },
    };
  }

  async function inspect(
    file: Blob,
    password = '',
    callOptions?: CallOptions,
  ): Promise<InspectResult> {
    const signal = callOptions?.signal;
    calls.inspect.push(nameOf(file));
    assertUsable(signal);
    const release = await acquire(signal);
    try {
      await pause(inspectDelayMs, signal);
      if (hold === 'inspect') await freeze(signal);
      assertUsable(signal);
      const scenario = scenarioFor(file);
      if (scenario.inspectError) {
        throw new PdfEngineError(scenario.inspectError.code, scenario.inspectError.detail);
      }
      return describe(scenario, file, password);
    } finally {
      release();
    }
  }

  async function process(
    request: ProcessRequest,
    callOptions?: ProcessCallOptions,
  ): Promise<ProcessResult> {
    const signal = callOptions?.signal;
    const { file, password, operation, output } = request;
    calls.process.push({ name: nameOf(file), password, operation, output });
    assertUsable(signal);
    const release = await acquire(signal);
    const started = performance.now();
    let last = -1;
    const report = (fraction: number): void => {
      if (fraction > last) {
        last = fraction;
        callOptions?.onProgress?.(fraction);
      }
    };
    try {
      // The real engine answers these quickly too: they are decided before any writing.
      await pause(Math.min(inspectDelayMs, processDelayMs), signal);
      const scenario = scenarioFor(file);
      if (scenario.inspectError) {
        throw new PdfEngineError(scenario.inspectError.code, scenario.inspectError.detail);
      }
      if (operation.kind === 'encrypt') {
        const problem = checkNewPasswords(operation.options);
        if (problem) throw new PdfEngineError(problem);
      } else if (!scenario.encryption) {
        throw new PdfEngineError('not-encrypted');
      }
      if (accessFor(scenario, password) === 'locked') {
        throw new PdfEngineError(password === '' ? 'password-required' : 'password-incorrect');
      }

      const stepMs = (processDelayMs * (scenario.slowness ?? 1)) / steps;
      for (let step = 1; step <= steps; step++) {
        // Never 1 before the job is done.
        const fraction = step / (steps + 1);
        if (typeof hold === 'number' && fraction > hold) {
          report(hold);
          await freeze(signal);
        }
        await pause(stepMs, signal);
        // Lets an abort that was requested by a progress listener take effect.
        await Promise.resolve();
        if (signal?.aborted || disposed) throw cancelled();
        report(fraction);
        if (scenario.processError && fraction >= 0.4) {
          throw new PdfEngineError(scenario.processError.code, scenario.processError.detail);
        }
      }

      const result = outputScenario(scenario, request);
      const blob = new Blob(minimalPdf(`${nameOf(file) || 'document'} - ${operation.kind}ed`), {
        type: 'application/pdf',
      });
      outputs.set(blob, result);
      const inputSize = scenario.size ?? file.size;
      const shrink = output?.streams === 'compress' ? 0.82 : 1;
      const overhead = operation.kind === 'encrypt' ? 412 : -287;
      report(1);
      return {
        blob,
        inputSize,
        outputSize: Math.max(blob.size, Math.round(inputSize * shrink) + overhead),
        durationMs: performance.now() - started,
        input: describe(scenario, file, password),
        pageCount: scenario.pages,
        verified: output?.verify ?? true,
        warnings: [...(scenario.warnings ?? [])],
      };
    } finally {
      release();
    }
  }

  return {
    async ready(): Promise<EngineInfo> {
      calls.ready++;
      assertUsable(undefined);
      await pause(inspectDelayMs, undefined);
      assertUsable(undefined);
      return { qpdfVersion: FAKE_QPDF_VERSION, concurrency, mode: options.mode ?? 'worker' };
    },
    inspect,
    process,
    dispose() {
      disposed = true;
      disposal.abort();
    },
    release() {
      hold = null;
      for (const thaw of [...frozen]) thaw();
    },
    setHold(next) {
      hold = next ?? null;
    },
    setUnavailable(next) {
      unavailable = next;
    },
    get held() {
      return frozen.size;
    },
    calls,
    get disposed() {
      return disposed;
    },
  };
}

// --- Development switches ------------------------------------------------------------------------

/**
 * Engine options from the page address of a development build:
 *
 *   ?fake                  use the fake engine (realistic delays)
 *   &hold=0.45             freeze every processing job at 45 %
 *   &hold=inspect          freeze every file in "analysing"
 *   &delay=1500            milliseconds a normal file takes to process (default 1500)
 *   &inspect=400           milliseconds an inspection takes (default 400)
 *   &unavailable           the engine cannot be loaded
 *   &mainthread            report the degraded main-thread mode
 */
export function fakeEngineOptionsFromUrl(params: URLSearchParams): FakeEngineOptions {
  const number = (name: string, fallback: number): number => {
    const value = Number(params.get(name));
    return params.has(name) && Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const holdParam = params.get('hold');
  const fraction = Number(holdParam);
  const hold =
    holdParam === 'inspect'
      ? 'inspect'
      : holdParam && fraction > 0 && fraction < 1
        ? fraction
        : null;
  return {
    inspectDelayMs: number('inspect', 400),
    processDelayMs: number('delay', 1500),
    steps: 30,
    hold,
    unavailable: params.has('unavailable'),
    mode: params.has('mainthread') ? 'main-thread' : 'worker',
  };
}

/**
 * Names of the demo files a development page should load at start: `&demo` (all of them) or
 * `&demo=plain.pdf,needs-password.pdf`. Empty without the parameter.
 */
export function demoFileNamesFromUrl(params: URLSearchParams): string[] {
  const value = params.get('demo');
  if (value === null) return [];
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return names.length > 0 ? names : [...DEMO_FILE_NAMES];
}
