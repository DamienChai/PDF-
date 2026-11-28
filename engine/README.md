# PDF engine

qpdf 12.4.2 compiled to WebAssembly, plus the wrapper that lets it work on browser `Blob`s without
ever holding a whole file in memory. Everything the application needs from it is the TypeScript
API in `src/engine/index.ts`; this directory is how the binary behind that API is made and
checked.

```
engine/
  build.sh                 the build (pinned sources, checksums, flags)
  src/pdfx.cc              C++ wrapper around libqpdf: I/O classes, JSON API, error mapping
  src/pdfx_lib.js          the three JavaScript imports of the module
  src/pdfx.d.mts           types of the generated glue
  src/jconfig.h            libjpeg configuration header
  tools/gen_stringprep.py  generates src/engine/stringprep-data.ts (RFC 3454 tables)
  bench.mjs                large-file benchmark (Node)
  browser-check/           real-browser check with Playwright (workers, CSP, fallbacks)
  THIRD_PARTY_NOTICES.md   licences of everything inside the binary
src/engine/
  dist/                    build output, committed: pdfx.wasm, pdfx.mjs, pdfx.d.mts, BUILDINFO.json
  types.ts  index.ts       public contract
  core.ts                  loads the module; byte sources/sinks; JSON marshalling; error mapping
  passwords.ts saslprep.ts typed password -> candidate byte strings / bytes to encrypt with
  jobs.ts                  inspect and process as jobs: candidates, verification, result mapping
  host.ts  worker.ts       serves jobs (in a worker, or in-thread as fallback)
  client.ts  protocol.ts   worker pool, queue, cancellation, crash recovery
tests/fixtures/            PDFs, their generator, the cross-validation
```

## Design

```
 UI thread                         worker (one job at a time)                    WebAssembly
 ─────────                         ──────────────────────────                    ───────────
 createPdfEngine()                 EngineHost                                    pdfx_inspect(json)
   .inspect(file, password)  ──►   inspectDocument / processDocument   ──►      pdfx_process(json)
   .process(request)               - candidates from the typed password            │
        ▲                          - verification of the output                     │ qpdf
        │ Blob                     BlobSource  ◄── pdfx_js_read(offset, n) ─────────┤  JsInputSource
        └────────────────────────  BlobOutputSink ◄── pdfx_js_write(chunk) ─────────┘  JsSink
```

- **No file system.** The module is linked with `-sFILESYSTEM=0`. Its only connections to the
  outside are three imports: read bytes, take output bytes, report progress (plus time and
  `crypto.getRandomValues`).
- **Input** (`JsInputSource`, a qpdf `InputSource`): bytes are pulled on demand through an LRU
  cache of 64 KiB blocks (64 MiB by default). A miss right behind a cached block is a scan and
  loads a run of blocks with one call; runs double up to 4 MiB. qpdf looks at the end of every
  stream before copying it, so a run is read _across_ blocks that are already cached, and a short
  hop ahead of an established scan extends the scan instead of fetching a lone block. Sparse
  access (qpdf visits every object once before writing) stays one small read per miss. The
  position/EOF/`last_offset` behaviour mirrors qpdf's `BufferInputSource` exactly.
- **Output** (`JsSink`, a qpdf `Pipeline`): 1 MiB chunks. In a worker each chunk becomes a `Blob`
  straight from the WebAssembly memory, so the output never sits in the JavaScript heap.
- **API**: `pdfx_inspect` / `pdfx_process` take a JSON request and return a malloc'ed JSON
  response (`pdfx_free`); `pdfx_version` returns static JSON. Passwords are arrays of hex strings
  (candidates, tried in order after the empty password); the index that matched is reported.
- **Errors**: every C++ exception is caught inside the module and mapped to one of the codes of
  `EngineErrorCode`. The instance stays usable after any error. Only a trap (a bug, or the stack
  running out) marks the instance broken; the host then creates a new one from the compiled module.
- **Randomness**: qpdf is built with `SKIP_OS_SECURE_RANDOM` and without `USE_INSECURE_RANDOM`,
  i.e. with no random source of its own. The wrapper installs one backed by `getentropy()`
  (`crypto.getRandomValues`). Without it qpdf throws; it cannot fall back to a weak generator.
- **Writer settings**: `preserve` = `qpdf_s_preserve` + `qpdf_o_preserve` (stream data is never
  decoded or recompressed, objects stay in their containers); `compress` = `qpdf_s_compress` +
  `qpdf_o_generate`. A newline is written before `endstream` (required by PDF/A, one byte per
  stream; pikepdf does the same). With these settings a decrypted file is byte-identical to what
  native qpdf writes, apart from the time-based `/ID`.

### Describing a document that cannot be opened

The UI shows algorithm, key length and permissions before the password is known. When qpdf rejects
a password it has already parsed the encryption dictionary, and `QPDF::isEncrypted(R, P, V, …)`,
the `allow*()` methods and the (never encrypted, already cached) `/Encrypt` dictionary can be read
from the instance whose `processInputSource` threw. That is what `inspect` does. qpdf's
`setPasswordIsHexKey` mode was evaluated as the alternative: it opens files with a classic
cross-reference table, but when the catalog lives in an object stream it fails after trying to
decrypt that stream with the dummy key (`unable to find page tree`) and the parameters have to be
read from a failed instance anyway — at the cost of a second parse. Both were tried on R2–R6.

### A file that lost its trailer

The trailer is the only place that says a file is encrypted. When it is gone (a download that
stopped early, a mangled `trailer` keyword), qpdf rebuilds one around the catalog it finds, without
`/Encrypt`: an encrypted file would come back as an unencrypted one whose strings and streams are
still ciphertext, and encrypting it again would bury that ciphertext for good. So when qpdf reports
`unable to find trailer dictionary while recovering damaged file` and the document looks
unencrypted, `openDocument` reads the raw input once more (`TraceScanner`: one sequential pass in
1 MiB windows through the block cache, memory independent of the file size) and fails with
`damaged` if it finds

- an `/Encrypt` entry: the name followed by a reference or a dictionary, as in a trailer (the
  name alone may be part of a text),
- an encryption dictionary (`/Filter /Standard` in an object that also has `/O` and `/U`),
- streams whose first bytes cannot be what their dictionaries announce, or
- no stream that could be tested at all.

The third one matters most: writers put the encryption dictionary at the end, so a cut usually
takes it along with the trailer, and ciphertext is all that gives the file away. One odd stream
proves nothing (writers leave placeholders, files get damaged in other ways too), so the streams
are counted. A stream with a telling first filter is a firm witness: a zlib header under
`/FlateDecode`, the JPEG or JPEG 2000 signature, the clear-table code under `/LZWDecode`,
printable characters under an ASCII filter. In an encrypted file practically every one of them
fails (a ciphertext passes the zlib test once in about a thousand times), in an unencrypted file
practically none. The file is refused when the streams that fail are at least as many as those
that pass. Only when no stream has such a filter are the unfiltered ones heard whose dictionary
has nothing but `/Length` (content streams, CMaps, scripts), by their first 16 to 256 bytes, and
each verdict needs evidence of its own. Data counts as written as it is if at least seven of
eight bytes are printable ASCII or white space, or if it begins with the signature of a file
that is compressed in itself. It counts as ciphertext if it looks random: about half of the
bytes with the high bit set, control characters among them, no value that keeps coming back.
Text in any encoding, tables of numbers and bitmaps do not look like that, but neither does one
short ciphertext in ten (20 to 60 bytes, the page content of a scan), so data that shows neither
sign counts as written only from 128 bytes on, where ciphertext is recognised all but three
times in ten thousand; a shorter sample says nothing. Streams that are empty or hold only white
space say nothing either, and neither do images without a filter or streams under
`/CCITTFaxDecode`, `/JBIG2Decode` and `/RunLengthDecode`.

A file in which nothing could be tested (it was cut off before its first page content, or has
only streams of the kinds just named) is refused as well: nothing tells whether its strings are
ciphertext, and what would be rebuilt from it has no page content anyway.

An unencrypted file with the same damage passes all of this and is repaired as before; its
made-up trailer gets a `/Size` entry before writing, which `QPDFWriter` would otherwise leave out.

### Passwords

A PDF password is a byte string. `src/engine/passwords.ts` turns typed text into candidates:

| Revision             | Candidates, in order                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R5, R6 (AES-256)     | SASLprep (RFC 4013) UTF-8 · raw UTF-8 · NFC · NFKC · NFD · PDFDocEncoding · Windows-1252 · Latin-1 · legacy code pages                                                                        |
| R2–R4 (RC4, AES-128) | PDFDocEncoding · Windows-1252 · Latin-1 · UTF-8 (raw, NFC, …) · GBK · Big5 · Shift_JIS · EUC-JP · EUC-KR · Windows-1251/1250/1253–1258/874 · KOI8-R/U · IBM866 · ISO-8859-2/5/7/15 · MacRoman |

Candidates are truncated to what the handler looks at (32 bytes up to R4, 127 from R5),
de-duplicated, and never contain a zero byte (qpdf takes C strings). ASCII passwords have exactly
one candidate. The legacy tables are built at run time from `TextDecoder`, nothing is bundled.
For writing: AES-256 uses SASLprep then UTF-8 (≤ 127 bytes), AES-128 uses PDFDocEncoding
(≤ 32 bytes).

## Building

Requirements: Emscripten **7.0.1** on `PATH` (or `EM_CONFIG` set), cmake ≥ 3.16, make, curl, tar,
sha256sum. About one minute on four cores.

```sh
engine/build.sh            # incremental
engine/build.sh --clean    # from scratch
```

The script downloads qpdf, zlib and libjpeg into `engine/.cache/` (several mirrors per file,
SHA-256 verified; `PDFX_OFFLINE=1` forbids downloading), builds under `engine/build/` and installs
into `src/engine/dist/`. Versions, checksums and flags are at the top of the script and are echoed
into `dist/BUILDINFO.json` together with the SHA-256 of the result. zlib and libjpeg are compiled
directly (no configure step; Emscripten "ports" are not used). No source is patched.

Environment: `PDFX_CACHE_DIR`, `PDFX_BUILD_DIR`, `PDFX_DIST_DIR`, `PDFX_JOBS`, `PDFX_OPT`,
`PDFX_LTO`, `PDFX_OFFLINE`, `PDFX_ALLOW_EMCC_MISMATCH` (see the header of `build.sh`).

The build is reproducible: three builds on the development machine (two different build
directories, one from a freshly downloaded cache) produced the same `pdfx.wasm`. A different
Emscripten build of the same version may produce different bytes, which is why the output is
committed. `.github/workflows/engine.yml` (manual trigger) rebuilds inside
`emscripten/emsdk:7.0.1` and uploads `dist/` as an artifact.

### Flags

`-O3 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -DNDEBUG` for everything; link:
`-sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=web,worker -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH
-sMAXIMUM_MEMORY=4GB -sINITIAL_MEMORY=32MB -sSTACK_SIZE=8MB -sABORTING_MALLOC=0 --no-entry`.

- `ENVIRONMENT=web,worker` keeps Node-only code (`import('node:module')`) out of the glue, so
  bundlers have nothing to stumble over. The glue still runs in Node (tests, benchmark) because
  the TypeScript side always supplies the compiled module through `instantiateWasm`.
- WebAssembly exceptions use the widely supported legacy encoding (Emscripten's default).
- `ABORTING_MALLOC=0`: a failed allocation becomes `std::bad_alloc` → `out-of-memory`.

### Build variants (measured, 500 MB AES-256 decrypt in Node 22, median of 3, two rounds)

| Build           | `pdfx.wasm` | gzip -9 |      Time |
| --------------- | ----------: | ------: | --------: |
| `-O3` (shipped) |   1 035 169 | 373 953 | 4.2–4.6 s |
| `-O2`           |   1 016 816 | 357 040 | 4.4–4.5 s |
| `-Os`           |     835 324 | 317 143 | 4.8–5.2 s |
| `-O3 -flto`     |   1 179 948 | 407 090 | 4.4–4.5 s |

LTO costs 14 % in size and gains nothing; `-Os` saves 57 KB over the wire for about 10 % of the
throughput. The table was measured before the lost-trailer check existed, which adds 11 448
bytes. Shipped now: 1 046 617 bytes raw, 378 907 gzip, 292 101 brotli; glue 9 623 bytes
(3 526 gzip).

Where the time goes (profile of the 500 MB decrypt): 67 % in qpdf's table-based AES, 21 % in
qpdf's per-16-byte-block pipeline plumbing, 5 % in the two JavaScript callbacks, the rest
elsewhere. A faster AES would need a SIMD implementation registered as a qpdf crypto provider.

## Checks

```sh
npx vitest run src/engine                  # 742 tests, about 15 s
python3 tests/fixtures/cross_check.py      # pikepdf + pypdf + native qpdf on 224 engine outputs
node engine/browser-check/check.mjs        # 42 checks in Chromium
node engine/bench.mjs                      # 100 MB and 500 MB
```

- **Unit and integration tests** (`src/engine/*.test.ts`, Node): every fixture is inspected with
  no, the user, the owner and a wrong password; decrypted with each password; encrypted with
  AES-256 and AES-128 and decrypted again, comparing the decoded page content and attachments with
  hashes recorded by pikepdf. Plus: every error fixture, output options, permission round trips,
  password rules (including the RFC 4013 examples and 314 SASLprep vectors generated from Python's
  RFC 3454 tables), every encrypted fixture cut off at six lengths (never taken for an unencrypted
  file) and every unencrypted one cut off at 35 (still repaired), the block cache with 64-byte blocks and four slots on every fixture, a read
  failure injected at every single read, failing sinks, mutated inputs, heap stability, and the
  worker pool with scripted and in-process workers.
- **Fixtures**: `tests/fixtures/generate.py` (see `tests/fixtures/README.md`).
- **Cross-validation**: see the docstring of `tests/fixtures/cross_check.py`.
- **Browser check**: production build under a sub-path, wrong `.wasm` MIME type, strict CSP, no
  `Worker`, worker script failing to load, missing `.wasm`, Vite dev server; with the benchmark
  files present also a 100 MB decrypt, abort mid-run and four overlapping jobs.
- **Benchmark**: creates `tests/fixtures/large/` (git-ignored) on first use. `--sizes`, `--runs`,
  `--algorithm aes-128`, `--dist DIR`, `--block/--cache/--max-read BYTES`, `--output file`.

### Reference numbers

Development machine (4 cores, Node 22.23, Chromium 158 headless):

| File (1 MiB image per page)           | Decrypt | Throughput | Read calls | Bytes read |     WebAssembly memory |
| ------------------------------------- | ------: | ---------: | ---------: | ---------: | ---------------------: |
| 100 MB, AES-256                       |  0.90 s |   111 MB/s |        131 |     106 MB |                  96 MB |
| 500 MB, AES-256                       |  4.59 s |   109 MB/s |        634 |     532 MB |   96 MB (19 % of file) |
| 500 MB, AES-256, 16 MiB cache         |  4.50 s |   111 MB/s |        637 |     532 MB |    38 MB (8 % of file) |
| 500 MB, AES-128                       |  3.71 s |   135 MB/s |        634 |     532 MB |                  96 MB |
| 4.7 GB (4 720 924 293 bytes), AES-256 |  41.4 s |   109 MB/s |      5 667 |   4 789 MB | 115 MB (2.6 % of file) |

The last row crosses the 4 GiB mark on purpose: offsets are 64-bit throughout although the module
is a 32-bit one, and the output was compared with the original using pikepdf. Inspecting the
500 MB file takes 3 reads (0.24 MB). In Chromium, through a worker with
`FileReaderSync` input and `Blob` output, the 100 MB file takes 1.15–1.4 s including the
verification pass. `FileReaderSync` costs about 0.4 ms per call plus 1–2 ms per MiB there, which
is why reads are batched.

## Integrating

- **Content-Security-Policy**: `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
connect-src 'self'`. Without `'wasm-unsafe-eval'` every call rejects with `engine-unavailable`.
- **Service worker**: the build emits `assets/pdfx-<hash>.wasm` and `assets/worker-<hash>.js`
  next to the application chunks. Precache patterns must include `wasm`.
- **Server**: `application/wasm` is preferred (streaming compilation); any other MIME type works
  through the `arrayBuffer` fallback.
- **Browsers**: WebAssembly exceptions and module workers — Chrome/Edge 95+, Firefox 114+,
  Safari 15.2+. Where module workers fail to start, the engine runs in the calling thread
  (`EngineInfo.mode === 'main-thread'`).

## Known limits

- qpdf buffers each stream in memory while writing it. Memory use is therefore the cache plus a
  few times the **largest single stream**, not a function of the file size; a PDF with one
  multi-hundred-megabyte stream needs correspondingly more, and fails with `out-of-memory` if
  that exceeds what the browser grants (the hard ceiling of the module is 4 GiB).
- Before writing, qpdf visits every object once. On a huge file with many scattered objects that
  is one small read per object cluster.
- Files written by the engine always grant the accessibility permission: bit 10 is deprecated
  since PDF 2.0 and qpdf keeps it set for R ≥ 4.
- For a V2 (RC4) document without `/Length`, qpdf assumes 128-bit keys where the specification
  says 40. `keyBits` reports what qpdf uses.
- Only the standard password security handler is supported; certificate-encrypted documents are
  reported as `unsupported-encryption`.
- The lost-trailer check errs on the side of refusing. Reported as `damaged` although they are
  not encrypted: a file that lost its trailer before its first page content began (nothing in
  it can be tested, see above); one with no stream under a telling filter whose `/Length`-only
  streams are all shorter than 128 bytes and not text; one that embeds an encrypted PDF without
  compression (qpdf would rebuild the document from the objects of both); one whose text spells
  out a complete `/Encrypt 12 0 R` entry or encryption dictionary; one in which the streams
  that do not begin the way their filter requires are at least as many as those that do.
- The other way round, an encrypted file that lost its trailer is taken for an unencrypted one
  only if its ciphertext passes the tests: with a single `/FlateDecode` stream left that happens
  about once in a thousand files, with two streams once in a million. Where the only stream
  that can be tested has no filter (a scan: one CCITT or JBIG2 image and a few dozen bytes of
  page content), it happens less than once in ten thousand files, and about three times in ten
  thousand if that content is 128 to 160 bytes long. One such scan in ten is refused because
  nothing in it can be told (`tests/fixtures/truncated-scan-r3.pdf`), the others because their
  content looks random.
- A zero byte cannot be part of a password (qpdf's API takes C strings).
