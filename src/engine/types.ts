/**
 * Public contract of the PDF engine.
 *
 * The engine is qpdf compiled to WebAssembly, running inside Web Workers. Everything in this file
 * is what the UI is allowed to depend on; the worker protocol and the WASM bindings are private to
 * `src/engine/`.
 *
 * All processing is local: files are read straight from the `Blob` the browser hands us and the
 * result is returned as a new `Blob`. Nothing is ever sent over the network.
 */

/** Cipher used for one class of data (streams, strings, attachments) inside the PDF. */
export type CipherMethod = 'none' | 'rc4' | 'aesv2' | 'aesv3' | 'unknown';

/**
 * Human-meaningful algorithm family of an encrypted document.
 * - `rc4`         RC4, 40–128 bit keys (PDF 1.1–1.5, obsolete)
 * - `aes-128`     AES-128 CBC (PDF 1.6)
 * - `aes-256-r5`  AES-256 with the deprecated Adobe "extension level 3" key derivation (R5)
 * - `aes-256`     AES-256 as standardised in PDF 2.0 (R6)
 */
export type AlgorithmId = 'rc4' | 'aes-128' | 'aes-256-r5' | 'aes-256' | 'unknown';

export type PrintPermission = 'full' | 'low' | 'none';

/** Document permissions as defined by the PDF standard security handler. */
export interface Permissions {
  /** Printing: full quality, low resolution only, or not allowed. */
  print: PrintPermission;
  /** Modify the document contents (anything not covered by the finer flags below). */
  modify: boolean;
  /** Copy / extract text and graphics. */
  extract: boolean;
  /** Add or change annotations (comments) and fill in form fields. */
  annotate: boolean;
  /** Fill in existing form fields and sign. */
  fillForms: boolean;
  /** Assemble the document: insert, delete, rotate pages, bookmarks. */
  assemble: boolean;
  /** Extract text for accessibility tools (screen readers). */
  accessibility: boolean;
}

/** Permissions with nothing restricted. */
export const ALL_PERMISSIONS: Readonly<Permissions> = Object.freeze({
  print: 'full',
  modify: true,
  extract: true,
  annotate: true,
  fillForms: true,
  assemble: true,
  accessibility: true,
});

/** Details of the encryption found in a document. */
export interface EncryptionInfo {
  algorithm: AlgorithmId;
  /** Effective key length in bits (40…256). */
  keyBits: number;
  /** Standard security handler revision (`/R`), 2…6. */
  revision: number;
  /** Encryption algorithm version (`/V`), 1…5. */
  version: number;
  /** Raw permission flags (`/P`) as a signed 32-bit integer. */
  rawPermissions: number;
  permissions: Permissions;
  streamMethod: CipherMethod;
  stringMethod: CipherMethod;
  /** Cipher used for embedded file attachments. */
  fileMethod: CipherMethod;
  /** False when the XMP metadata was deliberately left unencrypted. */
  encryptMetadata: boolean;
}

/**
 * How the document could be opened.
 * - `none`    not encrypted at all
 * - `locked`  encrypted and neither the empty password nor the supplied one works
 * - `user`    opened with the user ("open") password; owner-set restrictions technically apply
 * - `owner`   opened with the owner ("permissions") password; full access
 * - `both`    the password is both the user and the owner password
 */
export type AccessLevel = 'none' | 'locked' | 'user' | 'owner' | 'both';

export interface InspectResult {
  /** Size of the input in bytes. */
  fileSize: number;
  /** PDF header version, e.g. `"1.7"`; `null` if it could not be read while locked. */
  pdfVersion: string | null;
  encrypted: boolean;
  access: AccessLevel;
  /**
   * True when the document opens with an empty user password, i.e. it is either not encrypted or
   * only protected by an owner password (restrictions without an "open" password).
   */
  opensWithoutPassword: boolean;
  /** Encryption details. Available even while `access === 'locked'`; `null` if not encrypted. */
  encryption: EncryptionInfo | null;
  /** Number of pages; `null` while locked. */
  pageCount: number | null;
  /** Whether the file is linearized ("fast web view"); `null` while locked. */
  linearized: boolean | null;
  /** Non-fatal problems reported while reading (e.g. a repaired cross-reference table). */
  warnings: string[];
}

/** Settings for writing an encrypted document. */
export interface EncryptOptions {
  /**
   * `aes-256` (PDF 2.0, recommended) or `aes-128` (PDF 1.6, for very old readers).
   * RC4 is intentionally not offered for writing: it is broken.
   */
  algorithm: 'aes-256' | 'aes-128';
  /**
   * Password required to open the document. Empty string = the document opens without a password
   * and only the restrictions in `permissions` apply (requires a non-empty `ownerPassword`).
   */
  userPassword: string;
  /**
   * Password that grants full access / lets the restrictions be changed. Empty string = same as
   * `userPassword` (a single password with full access).
   */
  ownerPassword: string;
  permissions: Permissions;
  /** Also encrypt the XMP metadata (recommended). */
  encryptMetadata: boolean;
}

export type Operation =
  /** Remove encryption. Fails with `not-encrypted` if the input is not encrypted. */
  | { kind: 'decrypt' }
  /**
   * Add encryption. If the input is already encrypted it is opened with `ProcessRequest.password`
   * and re-encrypted with the new settings (change password / permissions).
   */
  | { kind: 'encrypt'; options: EncryptOptions };

export interface OutputOptions {
  /**
   * `preserve` keeps every content stream byte-for-byte (lossless, fastest — the default).
   * `compress` additionally compresses uncompressed streams and packs objects into object
   * streams, which usually makes the file smaller.
   */
  streams: 'preserve' | 'compress';
  /** Linearize the output ("fast web view"). Default false. */
  linearize: boolean;
  /** Re-open the produced file and check it before returning. Default true. */
  verify: boolean;
}

export interface ProcessRequest {
  /** The input document. A `File` is fine. It is read lazily, never copied wholesale. */
  file: Blob;
  /**
   * Password for opening the input, exactly as typed by the user ('' if none). The engine takes
   * care of Unicode normalisation and legacy encodings (PDFDocEncoding, GBK, Big5, Shift_JIS …).
   */
  password: string;
  operation: Operation;
  output?: Partial<OutputOptions>;
}

export interface ProcessResult {
  /** The produced document, `type: 'application/pdf'`. */
  blob: Blob;
  inputSize: number;
  outputSize: number;
  /** Wall-clock time spent inside the engine, in milliseconds. */
  durationMs: number;
  /** State of the input document as it was opened. */
  input: InspectResult;
  pageCount: number;
  /** True when the output was re-opened and its page count matched (see `OutputOptions.verify`). */
  verified: boolean;
  warnings: string[];
}

export type EngineErrorCode =
  /** Encrypted, and no password (or an empty one) was supplied. */
  | 'password-required'
  /** Encrypted, and the supplied password does not open it. */
  | 'password-incorrect'
  /** `decrypt` was requested but the document is not encrypted. */
  | 'not-encrypted'
  /** The data is not a PDF at all. */
  | 'not-pdf'
  /** The PDF is too damaged to be read, even after attempting recovery. */
  | 'damaged'
  /** Encrypted with something other than the standard password handler (e.g. certificates). */
  | 'unsupported-encryption'
  /** The new password cannot be represented in the chosen algorithm's encoding (AES-128). */
  | 'password-not-encodable'
  /** The new password exceeds the algorithm limit (127 UTF-8 bytes for AES-256, 32 for AES-128). */
  | 'password-too-long'
  /** Neither a user nor an owner password was given for `encrypt`. */
  | 'password-missing'
  /** The browser could not read the file (deleted, permission revoked …). */
  | 'read-failed'
  | 'out-of-memory'
  /** Aborted through the `AbortSignal`. */
  | 'cancelled'
  /** The engine could not be loaded (WebAssembly unsupported, assets missing …). */
  | 'engine-unavailable'
  | 'internal';

/** Every rejection coming out of the engine is an instance of this class. */
export class PdfEngineError extends Error {
  readonly code: EngineErrorCode;
  /** Low-level detail for logs / the "technical details" disclosure. Never shown as the headline. */
  readonly detail: string | undefined;

  constructor(code: EngineErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PdfEngineError';
    this.code = code;
    this.detail = detail;
  }
}

export interface EngineInfo {
  /** Version of the bundled qpdf library, e.g. `"12.4.2"`. */
  qpdfVersion: string;
  /** Number of workers the engine may run in parallel. */
  concurrency: number;
  /** `worker` normally; `main-thread` when workers are unavailable (degraded, UI may stutter). */
  mode: 'worker' | 'main-thread';
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface ProcessCallOptions extends CallOptions {
  /** Called with a monotonically increasing fraction in [0, 1]. */
  onProgress?: (fraction: number) => void;
}

export interface PdfEngine {
  /** Loads the WebAssembly module ahead of time. Optional: every call loads it on demand. */
  ready(): Promise<EngineInfo>;
  /**
   * Looks at a document without modifying it. Never rejects just because the password is wrong or
   * missing: that is reported as `access: 'locked'`.
   */
  inspect(file: Blob, password?: string, options?: CallOptions): Promise<InspectResult>;
  /** Decrypts or encrypts a document. Calls may overlap; they are queued across the worker pool. */
  process(request: ProcessRequest, options?: ProcessCallOptions): Promise<ProcessResult>;
  /** Terminates all workers. The instance must not be used afterwards. */
  dispose(): void;
}
