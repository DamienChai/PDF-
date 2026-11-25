/**
 * The two engine operations as they run next to the WebAssembly core: in the worker, or on the
 * main thread in the fallback mode. This is where the typed password becomes candidates, wire
 * results become contract types, and the output is checked.
 */
import {
  BlobSource,
  ChunkSource,
  type ByteSink,
  type ByteSource,
  type IoTuning,
  type PdfxCore,
  type RawEncryption,
  type RawInspect,
  type RawProcessSpec,
} from './core';
import { encodeNewPasswords, openCandidates, type NewPasswords } from './passwords';
import {
  PdfEngineError,
  type AlgorithmId,
  type EncryptionInfo,
  type InspectResult,
  type Operation,
  type OutputOptions,
  type ProcessResult,
} from './types';

export const DEFAULT_OUTPUT: Readonly<OutputOptions> = Object.freeze({
  streams: 'preserve',
  linearize: false,
  verify: true,
});

const PDF_MIME = 'application/pdf';

/** Collects the output and can hand it back for verification. */
export interface OutputSink extends ByteSink {
  /** Call once, after the last write. */
  finish(): Blob;
  /** The finished output as a readable source. */
  reopen(): ByteSource;
}

/** Keeps the chunks in memory. For environments without synchronous Blob reads. */
export class MemoryOutputSink implements OutputSink {
  private readonly chunks: Uint8Array[] = [];

  write(chunk: Uint8Array): void {
    this.chunks.push(chunk.slice());
  }

  finish(): Blob {
    return new Blob(this.chunks as BlobPart[], { type: PDF_MIME });
  }

  reopen(): ByteSource {
    return new ChunkSource(this.chunks);
  }
}

/**
 * Turns every chunk into a Blob straight from the WebAssembly memory. The browser keeps Blob data
 * outside the JavaScript heap (on disk when large), so the worker never holds the output, and the
 * chunk is copied once instead of twice. Measured in Chromium, this is about twice as fast as
 * collecting typed arrays first. Needs FileReaderSync to read the result back: workers only.
 */
export class BlobOutputSink implements OutputSink {
  private readonly parts: Blob[] = [];
  private blob: Blob | undefined;

  write(chunk: Uint8Array): void {
    this.parts.push(new Blob([chunk as BlobPart]));
  }

  finish(): Blob {
    this.blob = new Blob(this.parts, { type: PDF_MIME });
    return this.blob;
  }

  reopen(): ByteSource {
    if (!this.blob) {
      throw new Error('reopen() before finish()');
    }
    return new BlobSource(this.blob);
  }
}

// ---------------------------------------------------------------------------------------------
// Wire results -> contract types
// ---------------------------------------------------------------------------------------------

function algorithmOf(e: RawEncryption): AlgorithmId {
  if (e.version === 5) {
    return e.revision === 6 ? 'aes-256' : e.revision === 5 ? 'aes-256-r5' : 'unknown';
  }
  if (e.version === 4) {
    // Crypt filters: streams normally decide; a document may leave them in the clear.
    const method = [e.streamMethod, e.stringMethod, e.fileMethod].find((m) => m !== 'none');
    return method === 'aesv2' ? 'aes-128' : method === 'rc4' ? 'rc4' : 'unknown';
  }
  return 'rc4';
}

function toEncryptionInfo(e: RawEncryption): EncryptionInfo {
  return {
    algorithm: algorithmOf(e),
    keyBits: e.keyBits,
    revision: e.revision,
    version: e.version,
    rawPermissions: e.rawPermissions,
    permissions: e.permissions,
    streamMethod: e.streamMethod,
    stringMethod: e.stringMethod,
    fileMethod: e.fileMethod,
    encryptMetadata: e.encryptMetadata,
  };
}

function toWarnings(raw: { warnings: string[]; warningCount: number }): string[] {
  const hidden = raw.warningCount - raw.warnings.length;
  return hidden > 0 ? [...raw.warnings, `… and ${hidden} more`] : raw.warnings;
}

function toInspectResult(raw: Omit<RawInspect, 'stats'>): InspectResult {
  return {
    fileSize: raw.fileSize,
    pdfVersion: raw.pdfVersion || null,
    encrypted: raw.encrypted,
    access: raw.access,
    opensWithoutPassword: raw.opensWithoutPassword,
    encryption: raw.encryption ? toEncryptionInfo(raw.encryption) : null,
    pageCount: raw.pageCount,
    linearized: raw.linearized,
    warnings: toWarnings(raw),
  };
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

/**
 * Candidates worth trying for a document in the state `first` (the result of opening it without
 * any password). None if the empty password already gives everything there is to get.
 */
function candidatesFor(first: RawInspect, password: string): Uint8Array[] {
  if (!first.encryption || (first.access !== 'locked' && first.access !== 'user')) {
    return [];
  }
  return openCandidates(password, first.encryption.revision);
}

export function inspectDocument(
  core: PdfxCore,
  source: ByteSource,
  password: string,
  tuning?: IoTuning,
): InspectResult {
  const first = core.inspect(source, [], tuning);
  const candidates = candidatesFor(first, password);
  return toInspectResult(candidates.length > 0 ? core.inspect(source, candidates, tuning) : first);
}

export interface ProcessJob {
  password: string;
  operation: Operation;
  output?: Partial<OutputOptions>;
}

function verificationFailed(what: string): PdfEngineError {
  return new PdfEngineError('internal', `output verification failed: ${what}`);
}

/** Re-opens the output and checks that it is what was asked for. Throws if it is not. */
function verifyOutput(
  core: PdfxCore,
  output: ByteSource,
  expectedPages: number,
  expectedSize: number,
  operation: Operation,
  passwords: NewPasswords | undefined,
  tuning: IoTuning | undefined,
): void {
  if (output.size !== expectedSize) {
    throw verificationFailed(`${output.size} bytes stored, ${expectedSize} written`);
  }
  let after: RawInspect;
  try {
    after = core.inspect(
      output,
      passwords && passwords.user.length > 0 ? [passwords.user] : [],
      tuning,
    );
    if (passwords && toKey(passwords.owner) !== toKey(passwords.user)) {
      const asOwner = core.inspect(output, [passwords.owner], tuning);
      if (asOwner.access !== 'owner' && asOwner.access !== 'both') {
        throw verificationFailed('the owner password does not give owner access');
      }
    }
  } catch (error) {
    if (error instanceof PdfEngineError && error.code === 'internal') {
      throw error;
    }
    throw verificationFailed(`the output does not open (${String(error)})`);
  }
  if (after.pageCount !== expectedPages) {
    throw verificationFailed(`${String(after.pageCount)} pages instead of ${expectedPages}`);
  }
  if (operation.kind === 'decrypt') {
    if (after.encrypted) {
      throw verificationFailed('the output is still encrypted');
    }
    return;
  }
  const revision = operation.options.algorithm === 'aes-256' ? 6 : 4;
  if (after.encryption?.revision !== revision) {
    throw verificationFailed('the output is not encrypted as requested');
  }
  if (passwords && passwords.user.length > 0 && after.opensWithoutPassword) {
    throw verificationFailed('the output opens without the password');
  }
}

function toKey(bytes: Uint8Array): string {
  return bytes.join(',');
}

/**
 * Runs a decrypt or encrypt job. `onProgress` receives fractions in [0, 1], not necessarily
 * increasing strictly; the last one is 1.
 */
export function processDocument(
  core: PdfxCore,
  source: ByteSource,
  job: ProcessJob,
  sink: OutputSink,
  onProgress: (fraction: number) => void,
  tuning?: IoTuning,
): ProcessResult {
  const started = performance.now();
  const output: OutputOptions = { ...DEFAULT_OUTPUT, ...job.output };
  const { operation } = job;

  // Fail on unusable new passwords before touching the file.
  const passwords =
    operation.kind === 'encrypt' ? encodeNewPasswords(operation.options) : undefined;

  const first = core.inspect(source, [], tuning);
  if (operation.kind === 'decrypt' && !first.encrypted) {
    throw new PdfEngineError('not-encrypted');
  }
  const candidates = candidatesFor(first, job.password);
  if (first.access === 'locked' && candidates.length === 0) {
    throw new PdfEngineError(job.password === '' ? 'password-required' : 'password-incorrect');
  }

  const spec: RawProcessSpec = {
    operation: operation.kind,
    streams: output.streams,
    linearize: output.linearize,
  };
  if (operation.kind === 'encrypt' && passwords) {
    spec.encrypt = {
      algorithm: operation.options.algorithm,
      user: passwords.user,
      owner: passwords.owner,
      permissions: operation.options.permissions,
      encryptMetadata: operation.options.encryptMetadata,
    };
  }

  // Writing is nearly all of the work; the verification pass only re-reads the structure.
  const writeShare = output.verify ? 0.97 : 1;
  const raw = core.process(
    source,
    candidates,
    spec,
    sink,
    (percent) => onProgress(Math.min(percent / 100, 0.999) * writeShare),
    tuning,
  );
  const blob = sink.finish();

  if (output.verify) {
    verifyOutput(core, sink.reopen(), raw.pageCount, raw.outputSize, operation, passwords, tuning);
  }
  onProgress(1);

  return {
    blob,
    inputSize: source.size,
    outputSize: raw.outputSize,
    durationMs: performance.now() - started,
    input: toInspectResult(raw.input),
    pageCount: raw.pageCount,
    verified: output.verify,
    warnings: toWarnings(raw),
  };
}
