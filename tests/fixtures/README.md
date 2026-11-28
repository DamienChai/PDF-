# Engine test fixtures

Small PDFs for `src/engine/*.test.ts`, described by `manifest.json`.

| File                        | What                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `generate.py`               | Creates every fixture, `manifest.json` and `saslprep-vectors.json`                     |
| `manifest.json`             | Per fixture: passwords (as typed and as bytes), expected encryption parameters, permissions, page count, hashes of the decoded page content and attachments, page text |
| `saslprep-vectors.json`     | SASLprep inputs and results computed from Python's RFC 3454 tables                     |
| `cross_check.py`            | Validates engine outputs with pikepdf, pypdf and native qpdf                           |
| `cross_check.driver.ts`     | Produces those outputs (run by `cross_check.py` through Vitest)                        |
| `cross-check.config.ts`     | Vitest configuration that runs only the driver                                         |
| `large/`                    | Benchmark files created by `engine/bench.mjs` (git-ignored)                            |

## What is covered

- Unencrypted: classic cross-reference table, object streams + cross-reference stream, linearized,
  hand-written with CRLF and with CR line endings.
- One file per algorithm: RC4-40 (R2), RC4-128 (R3), RC4-128 via a V2 crypt filter (R4), AES-128
  (R4), AES-256 R5, AES-256 R6; user + owner password, a single password, owner password only.
- `EncryptMetadata false`; object streams; linearized; embedded file attachment; bytes before the
  `%PDF-` header.
- Passwords: stored as SASLprep(typed) and as raw un-normalised UTF-8 (CJK, full-width letters,
  soft hyphen, ideographic space, Roman numeral); stored decomposed (NFD); Latin-1; PDFDocEncoding
  vs Windows-1252 (euro sign); UTF-8 bytes in an R4 file; GBK, Big5, Shift_JIS, EUC-KR and
  Windows-1251 bytes; longer than the 32 significant bytes.
- Written by other software: pypdf (RC4-40, RC4-128, AES-128, AES-256 R5, AES-256 R6) and
  ReportLab (RC4-40, RC4-128, ASCII85 + Flate content streams).
- Damaged: wrong `startxref` (recoverable, plain and encrypted); cut off after 700 bytes (not
  recoverable).
- Cut off before the trailer: unencrypted at 97 % (`truncated-plain.pdf`, repaired); AES-256 R6
  at 90 % (half of the encryption dictionary left), RC4-128 at 90 % and AES-128 at 50 % (no
  encryption dictionary left either): `truncated-r6.pdf`, `truncated-r3.pdf`,
  `truncated-early-r4.pdf` must be refused as `damaged`, never taken for unencrypted files. The
  same for `truncated-lzw-r2.pdf`: RC4-40, hand-written with LZW streams only (as scanners wrote
  them in the 1990s), cut off behind the last stream, so that no stream has a zlib header to
  miss.
- Not PDFs: binary and text.
- Unsupported: certificate security handler (`/Adobe.PubSec`), unknown revision (R7/V6).

## Regenerating

```sh
pip install pikepdf pypdf cryptography reportlab
python3 tests/fixtures/generate.py
```

Encryption uses random salts and IVs, so regenerated files differ byte for byte from the committed
ones while being equivalent; `manifest.json` is rewritten to match. The expectations in the
manifest are read back from the generated files with pikepdf (native qpdf) and pypdf, and the
exact password bytes are verified with pypdf.

## Cross-validation

```sh
python3 tests/fixtures/cross_check.py            # runs the engine, then validates
python3 tests/fixtures/cross_check.py --out DIR  # keep the engine outputs
```

Last run (pikepdf 10.18.2 with qpdf 12.4.2, pypdf 6.17.0): 224 outputs from 48 fixtures, all
accepted by pikepdf and pypdf; all 121 decrypted outputs byte-identical to native qpdf performing
the same operation (ignoring the time-based `/ID`), all 103 encrypted outputs object-identical
after decryption.
