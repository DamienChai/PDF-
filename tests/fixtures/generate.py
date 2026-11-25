#!/usr/bin/env python3
"""Generates the PDF fixtures of the engine tests and tests/fixtures/manifest.json.

    pip install pikepdf pypdf cryptography reportlab
    python3 tests/fixtures/generate.py

The fixtures are committed; re-running is only needed to add or change one. Encryption uses random
salts and IVs, so regenerated files differ byte for byte from the committed ones while being
equivalent. Everything the tests expect is recorded in the manifest, and the expectations about
encryption parameters and permissions are read back with pikepdf (native qpdf), not assumed.
"""
from __future__ import annotations

import hashlib
import io
import json
import pathlib
import random
import stringprep
import unicodedata
import warnings

import pikepdf
import pypdf
from pikepdf import Dictionary, Encryption, Name, Permissions

HERE = pathlib.Path(__file__).resolve().parent
MANIFEST: list[dict] = []

warnings.filterwarnings("ignore", message="Encryption R=5 is deprecated")

ALL = Permissions(
    accessibility=True,
    extract=True,
    modify_annotation=True,
    modify_assembly=True,
    modify_form=True,
    modify_other=True,
    print_lowres=True,
    print_highres=True,
)
RESTRICTED = Permissions(
    accessibility=True,
    extract=False,
    modify_annotation=False,
    modify_assembly=False,
    modify_form=True,
    modify_other=False,
    print_lowres=True,
    print_highres=False,
)
LOCKED_DOWN = Permissions(
    accessibility=False,
    extract=False,
    modify_annotation=False,
    modify_assembly=False,
    modify_form=False,
    modify_other=False,
    print_lowres=False,
    print_highres=False,
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------------------------
# Source documents
# --------------------------------------------------------------------------------------------


def build_document(label: str, pages: int = 4, xmp: bool = False, attachment: bool = False) -> pikepdf.Pdf:
    """A small document with distinct text on every page, an incompressible image and metadata."""
    rng = random.Random(f"pdf-key:{label}")
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
    )
    image = pdf.make_stream(
        bytes(rng.getrandbits(8) for _ in range(1501)),  # odd length: exercises cipher padding
        Type=Name.XObject,
        Subtype=Name.Image,
        Width=19,
        Height=79,
        ColorSpace=Name.DeviceGray,
        BitsPerComponent=8,
    )
    for number in range(1, pages + 1):
        lines = [
            "q 60 0 0 80 220 60 cm /Im1 Do Q",
            "BT /F1 16 Tf 24 150 Td",
            f"(PDF Key fixture {label} page {number} of {pages}) Tj",
            "0 -22 Td",
            f"(token {rng.getrandbits(64):016x}) Tj ET",
        ]
        # A longer, repetitive tail on the first page gives the 'compress' mode something to do.
        if number == 1:
            lines += [f"{x} {x % 97} m {x + 3} {x % 89} l S" for x in range(0, 400)]
        page = pdf.add_blank_page(page_size=(300, 200))
        page.Resources = Dictionary(Font=Dictionary(F1=font), XObject=Dictionary(Im1=image))
        page.Contents = pdf.make_stream(("\n".join(lines) + "\n").encode("ascii"))
    pdf.docinfo["/Title"] = f"PDF Key fixture \u2013 {label} \u2013 \u6587\u6863"
    pdf.docinfo["/Author"] = "tests/fixtures/generate.py"
    if xmp:
        with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
            meta["dc:title"] = f"PDF Key fixture {label}"
            meta["dc:creator"] = ["generate.py"]
    if attachment:
        pdf.attachments["note.txt"] = (f"attachment of {label}\n" * 40).encode("ascii")
    return pdf


def page_hashes(pdf: pikepdf.Pdf) -> list[str]:
    hashes = []
    for page in pdf.pages:
        contents = page.Contents
        if isinstance(contents, pikepdf.Array):
            data = b"".join(part.read_bytes() for part in contents)
        else:
            data = contents.read_bytes()
        hashes.append(sha256(data))
    return hashes


def attachment_hashes(pdf: pikepdf.Pdf) -> dict[str, str]:
    return {name: sha256(spec.get_file().read_bytes()) for name, spec in pdf.attachments.items()}


# --------------------------------------------------------------------------------------------
# Manifest
# --------------------------------------------------------------------------------------------


def algorithm_of(info) -> str:
    if info.V == 5:
        return "aes-256" if info.R == 6 else "aes-256-r5"
    if info.V == 4:
        return "aes-128" if info.stream_method.name == "aes" else "rc4"
    return "rc4"


def describe_encryption(pdf: pikepdf.Pdf) -> dict | None:
    if not pdf.is_encrypted:
        return None
    info = pdf.encryption
    allow = pdf.allow
    encrypt = pdf.trailer["/Encrypt"]
    methods = {"rc4": "rc4", "aes": "aesv2", "aesv3": "aesv3", "none": "none", "unknown": "unknown"}
    legacy = info.V < 4  # no crypt filters: everything is RC4
    return {
        "algorithm": algorithm_of(info),
        "keyBits": info.bits,
        "revision": info.R,
        "version": info.V,
        "rawPermissions": info.P,
        "permissions": {
            "print": "full" if allow.print_highres else "low" if allow.print_lowres else "none",
            "modify": allow.modify_other,
            "extract": allow.extract,
            "annotate": allow.modify_annotation,
            "fillForms": allow.modify_form,
            "assemble": allow.modify_assembly,
            "accessibility": allow.accessibility,
        },
        "streamMethod": "rc4" if legacy else methods[info.stream_method.name],
        "stringMethod": "rc4" if legacy else methods[info.string_method.name],
        "fileMethod": "rc4" if legacy else methods[info.file_method.name],
        "encryptMetadata": bool(encrypt.get("/EncryptMetadata", True)) if info.V >= 4 else True,
    }


def password_bytes(typed: str | None, revision: int | None) -> bytes | None:
    """The bytes a compliant writer stores for a typed password (None if there is no password)."""
    if not typed:
        return None
    return typed.encode("utf-8") if revision is None or revision >= 5 else typed.encode("pdfdoc")


def record(
    name: str,
    description: str,
    *,
    user: str | None = None,
    owner: str | None = None,
    user_bytes: bytes | None = None,
    owner_bytes: bytes | None = None,
    wrong: str = "not-the-password",
    expect_warnings: bool = False,
    tags: tuple[str, ...] = (),
) -> None:
    """Adds a readable fixture to the manifest, with expectations read back by pikepdf and pypdf.

    `user` / `owner` are the passwords as a person would type them. `user_bytes` / `owner_bytes`
    are the exact bytes the file was encrypted with, when they are not what a compliant writer
    derives from the typed text (UTF-8 for R5/R6, PDFDocEncoding before).
    """
    path = HERE / name
    data = path.read_bytes()
    revision = None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            pikepdf.open(path).close()
            empty_ok = True
        except pikepdf.PasswordError:
            empty_ok = False
        if b"/Encrypt" in data:
            revision = 6 if b"/V 5" in data else 4
        user_bytes = user_bytes or password_bytes(user, revision)
        owner_bytes = owner_bytes or password_bytes(owner, revision)
        best = owner_bytes or user_bytes or b""
        # pikepdf encodes a str password as UTF-8 when opening; bytes are passed on verbatim.
        pdf = pikepdf.open(path, password=best)
    with pdf:
        reader = pypdf.PdfReader(path)
        if reader.is_encrypted:
            assert reader.decrypt(best), f"{name}: pypdf cannot open it"
        if user_bytes:
            check_bytes_open(name, user_bytes, 2 if user_bytes == owner_bytes else 1)
        if owner_bytes:
            check_bytes_open(name, owner_bytes, 2)
        MANIFEST.append(
            {
                "file": name,
                "description": description,
                "kind": "ok",
                "tags": list(tags),
                "userPassword": user,
                "ownerPassword": owner,
                "userPasswordHex": user_bytes.hex() if user_bytes else None,
                "ownerPasswordHex": owner_bytes.hex() if owner_bytes else None,
                "wrongPassword": wrong,
                "size": len(data),
                "sha256": sha256(data),
                "pdfVersion": pdf.pdf_version,
                "encrypted": pdf.is_encrypted,
                "opensWithoutPassword": empty_ok,
                "encryption": describe_encryption(pdf),
                "pageCount": len(pdf.pages),
                "linearized": pdf.is_linearized,
                "pageContentSha256": page_hashes(pdf),
                "pageText": [page.extract_text() for page in reader.pages],
                "attachmentSha256": attachment_hashes(pdf),
                "expectWarnings": expect_warnings,
            }
        )


def record_error(name: str, description: str, error: str, password: str = "") -> None:
    path = HERE / name
    MANIFEST.append(
        {
            "file": name,
            "description": description,
            "kind": "error",
            "error": error,
            "password": password,
            "size": path.stat().st_size,
            "sha256": sha256(path.read_bytes()),
        }
    )


def save(pdf: pikepdf.Pdf, name: str, **kwargs) -> None:
    kwargs.setdefault("static_id", True)
    pdf.save(HERE / name, **kwargs)


def check_bytes_open(name: str, password: bytes, expected: int) -> None:
    """Independent check (pypdf) that `password` opens the file as user (1) or owner (2)."""
    result = pypdf.PdfReader(HERE / name).decrypt(password)
    assert int(result) == expected, f"{name}: pypdf.decrypt({password!r}) = {result!r}, expected {expected}"


# --------------------------------------------------------------------------------------------
# Hand-written files
# --------------------------------------------------------------------------------------------


def raw_pdf(
    objects: list[bytes],
    trailer_extra: bytes = b"",
    eol: bytes = b"\n",
    version: bytes = b"1.4",
    prefix: bytes = b"",
) -> bytes:
    """Serialises numbered objects with a classic cross-reference table."""
    out = bytearray(b"%PDF-" + version + eol + b"%\xe2\xe3\xcf\xd3" + eol)
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj" % number + eol + body + eol + b"endobj" + eol
    xref = len(out)
    entry_eol = eol if len(eol) == 2 else b" " + eol  # entries are exactly 20 bytes
    out += b"xref" + eol + b"0 %d" % (len(objects) + 1) + eol
    out += b"0000000000 65535 f" + entry_eol
    for offset in offsets:
        out += b"%010d 00000 n" % offset + entry_eol
    out += b"trailer" + eol + b"<< /Size %d /Root 1 0 R %s >>" % (len(objects) + 1, trailer_extra) + eol
    out += b"startxref" + eol + b"%d" % xref + eol + b"%%EOF" + eol
    return prefix + bytes(out)


def simple_objects(label: str, pages: int, eol: bytes = b"\n") -> list[bytes]:
    kids = b" ".join(b"%d 0 R" % (4 + 2 * i) for i in range(pages))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Count %d /Kids [ %s ] >>" % (pages, kids),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for i in range(pages):
        content = b"BT /F1 14 Tf 20 100 Td (%s page %d of %d) Tj ET" % (label.encode(), i + 1, pages)
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents %d 0 R "
            b"/Resources << /Font << /F1 3 0 R >> >> >>" % (5 + 2 * i)
        )
        objects.append(b"<< /Length %d >>" % len(content) + eol + b"stream" + eol + content + eol + b"endstream")
    return objects


# --------------------------------------------------------------------------------------------
# SASLprep reference vectors
# --------------------------------------------------------------------------------------------


def saslprep_map(text: str) -> str:
    spaced = (" " if stringprep.in_table_c12(c) else c for c in text)
    return "".join(c for c in spaced if not stringprep.in_table_b1(c))


def saslprep_reference(text: str) -> tuple[str, str | None]:
    """RFC 4013 built from the stdlib's RFC 3454 tables. Unassigned code points are allowed.

    U+200B is in both mapping tables; like GNU libidn, the space mapping wins.
    """
    mapped = saslprep_map(text)
    value = unicodedata.ucd_3_2_0.normalize("NFKC", mapped)
    prohibited_tables = (
        stringprep.in_table_c12,
        stringprep.in_table_c21,
        stringprep.in_table_c22,
        stringprep.in_table_c3,
        stringprep.in_table_c4,
        stringprep.in_table_c5,
        stringprep.in_table_c6,
        stringprep.in_table_c7,
        stringprep.in_table_c8,
        stringprep.in_table_c9,
    )
    if any(table(c) for c in value for table in prohibited_tables):
        return value, "prohibited"
    rand_al = [stringprep.in_table_d1(c) for c in value]
    if any(rand_al) and (any(stringprep.in_table_d2(c) for c in value) or not rand_al[0] or not rand_al[-1]):
        return value, "bidi"
    return value, None


def write_saslprep_vectors() -> None:
    rng = random.Random("saslprep")
    pools = [
        (0x20, 0x7E),  # ASCII
        (0xA0, 0xFF),  # Latin-1 (NBSP, soft hyphen, ordinals)
        (0x100, 0x24F),  # Latin Extended
        (0x300, 0x36F),  # combining marks
        (0x370, 0x3FF),  # Greek
        (0x400, 0x4FF),  # Cyrillic
        (0x590, 0x5FF),  # Hebrew
        (0x600, 0x6FF),  # Arabic
        (0x1680, 0x1680),
        (0x2000, 0x206F),  # spaces, zero-width and bidi controls
        (0x2100, 0x218F),  # letterlike, Roman numerals
        (0x2460, 0x24FF),  # enclosed alphanumerics
        (0x3000, 0x303F),  # CJK punctuation, ideographic space
        (0x3040, 0x30FF),  # kana
        (0x4E00, 0x4FFF),  # CJK ideographs
        (0xAC00, 0xAD00),  # Hangul
        (0xE000, 0xE010),  # private use
        (0xFB00, 0xFB4F),  # ligatures, Hebrew presentation forms
        (0xFE00, 0xFE0F),  # variation selectors
        (0xFF00, 0xFFEF),  # full-width forms
        (0xFFF9, 0xFFFD),
        (0x1D400, 0x1D4FF),  # mathematical alphanumerics (NFKC folds them)
        (0xE0001, 0xE0001),
    ]
    texts = [
        "I\u00adX",
        "user",
        "USER",
        "\u00aa",
        "\u2168",
        "\u0007",
        "\u0627\u0031",
        "",
        " ",
        "\u00a0",
        "\u05d0\u05d1\u05d2",
        "\u05d0abc\u05d1",
        "\u05d01\u05d1",
        "abc\u05d0",
        "\u0627\u0628\u062a",
        "\uff30\uff41\uff53\uff53",
        "\u5bc6\u7801\uff30\uff41\uff53\uff53\u00adword\u3000\u2168",
        "pa\u0308ssword",
        "\u200bzero\u200dwidth",
        "tab\there",
        "\ue000",
        "\ufffd",
        "\U000e0001",
    ]
    while len(texts) < 400:
        length = rng.randint(1, 8)
        chars = []
        for _ in range(length):
            low, high = rng.choice(pools if rng.random() < 0.7 else pools[:1])
            chars.append(chr(rng.randint(low, high)))
        texts.append("".join(chars))
    vectors = []
    for text in texts:
        # Only characters that exist in Unicode 3.2 (the tables know nothing newer) and whose
        # normalisation has not changed since, so that any NFKC implementation agrees.
        if any(unicodedata.ucd_3_2_0.category(c) == "Cn" for c in text):
            continue
        value, failure = saslprep_reference(text)
        if unicodedata.normalize("NFKC", saslprep_map(text)) != value:
            continue
        vectors.append([text, value, failure])
    # One [input, output, failure] triple per line.
    lines = ",\n".join(json.dumps(v) for v in vectors)
    (HERE / "saslprep-vectors.json").write_text("[\n" + lines + "\n]\n", encoding="ascii")
    counts = {k: sum(1 for v in vectors if v[2] == k) for k in (None, "prohibited", "bidi")}
    print(f"{len(vectors)} SASLprep vectors {counts}")


# --------------------------------------------------------------------------------------------
# The fixtures
# --------------------------------------------------------------------------------------------


def main() -> None:
    for old in HERE.glob("*.pdf"):
        old.unlink()
    for old in HERE.glob("*.bin"):
        old.unlink()

    # --- unencrypted ---------------------------------------------------------------------
    plain = build_document("plain", xmp=True)
    save(plain, "plain.pdf", compress_streams=False, stream_decode_level=pikepdf.StreamDecodeLevel.none)
    record("plain.pdf", "Unencrypted, classic cross-reference table, uncompressed streams", tags=("plain",))

    save(build_document("objstm-plain"), "objstm-plain.pdf", object_stream_mode=pikepdf.ObjectStreamMode.generate)
    record("objstm-plain.pdf", "Unencrypted, object streams and a cross-reference stream", tags=("plain", "objstm"))

    save(build_document("linearized-plain"), "linearized-plain.pdf", linearize=True)
    record("linearized-plain.pdf", "Unencrypted, linearized", tags=("plain", "linearized"))

    # --- one per algorithm, user + owner password -----------------------------------------
    def encrypted(name, description, label, R, *, aes=True, metadata=True, allow=ALL, user="user", owner="owner",
                  tags=(), xmp=False, attachment=False, **save_args):
        pdf = build_document(label, xmp=xmp, attachment=attachment)
        save(pdf, name, encryption=Encryption(user=user, owner=owner, R=R, aes=aes, metadata=metadata, allow=allow),
             **save_args)
        record(name, description, user=user or None, owner=owner or None, tags=tags)

    encrypted("rc4-40-r2.pdf", "RC4 40-bit (R2)", "rc4-40", 2, aes=False, metadata=False, allow=RESTRICTED)
    encrypted("rc4-128-r3.pdf", "RC4 128-bit (R3)", "rc4-128", 3, aes=False, metadata=False, allow=RESTRICTED)
    encrypted("rc4-128-r4.pdf", "RC4 128-bit through a V2 crypt filter (R4)", "rc4-r4", 4, aes=False, metadata=False)
    encrypted("aes-128-r4.pdf", "AES-128 (R4)", "aes-128", 4, allow=RESTRICTED, xmp=True)
    encrypted("aes-256-r5.pdf", "AES-256, deprecated R5 key derivation", "aes-256-r5", 5, xmp=True)
    encrypted("aes-256-r6.pdf", "AES-256 (R6, PDF 2.0)", "aes-256", 6, allow=RESTRICTED, xmp=True)

    # --- single password ------------------------------------------------------------------
    encrypted("same-password-r6.pdf", "AES-256, user and owner password identical", "same-password", 6,
              user="both", owner="both")
    encrypted("same-password-r3.pdf", "RC4-128, user and owner password identical", "same-password-r3", 3,
              aes=False, metadata=False, user="both", owner="both")

    # --- owner password only (opens without a password, restricted) -------------------------
    encrypted("owner-only-r6.pdf", "AES-256, empty user password, restrictions", "owner-only-r6", 6,
              user="", owner="owner", allow=LOCKED_DOWN, tags=("owner-only",))
    encrypted("owner-only-r4.pdf", "AES-128, empty user password, restrictions", "owner-only-r4", 4,
              user="", owner="owner", allow=RESTRICTED, tags=("owner-only",))
    encrypted("owner-only-r3.pdf", "RC4-128, empty user password, restrictions", "owner-only-r3", 3,
              aes=False, metadata=False, user="", owner="owner", allow=LOCKED_DOWN, tags=("owner-only",))

    # --- cleartext metadata -----------------------------------------------------------------
    encrypted("cleartext-metadata-r4.pdf", "AES-128 with EncryptMetadata false", "cleartext-metadata-r4", 4,
              metadata=False, xmp=True, tags=("cleartext-metadata",))
    encrypted("cleartext-metadata-r6.pdf", "AES-256 with EncryptMetadata false", "cleartext-metadata-r6", 6,
              metadata=False, xmp=True, tags=("cleartext-metadata",))

    # --- structure variants -----------------------------------------------------------------
    encrypted("objstm-r6.pdf", "AES-256, object streams and a cross-reference stream", "objstm-r6", 6,
              tags=("objstm",), object_stream_mode=pikepdf.ObjectStreamMode.generate)
    encrypted("objstm-r4.pdf", "AES-128, object streams and a cross-reference stream", "objstm-r4", 4,
              tags=("objstm",), object_stream_mode=pikepdf.ObjectStreamMode.generate)
    encrypted("linearized-r6.pdf", "AES-256, linearized", "linearized-r6", 6, tags=("linearized",), linearize=True)
    encrypted("linearized-r3.pdf", "RC4-128, linearized", "linearized-r3", 3, aes=False, metadata=False,
              tags=("linearized",), linearize=True)
    encrypted("attachment-r6.pdf", "AES-256 with an embedded file", "attachment-r6", 6,
              attachment=True, tags=("attachment",))
    encrypted("attachment-r4.pdf", "AES-128 with an embedded file", "attachment-r4", 4,
              attachment=True, tags=("attachment",))

    # --- files written by other libraries (independent implementations of the security handler) ---
    def pypdf_encrypted(name: str, description: str, label: str, algorithm: str) -> None:
        buffer = io.BytesIO()
        build_document(label).save(buffer, static_id=True)
        writer = pypdf.PdfWriter(clone_from=pypdf.PdfReader(buffer))
        writer.encrypt(user_password="user", owner_password="owner", algorithm=algorithm)
        with open(HERE / name, "wb") as stream:
            writer.write(stream)
        record(name, description, user="user", owner="owner", tags=("pypdf",))

    pypdf_encrypted("pypdf-rc4-40.pdf", "Written by pypdf: RC4 40-bit", "pypdf-rc4-40", "RC4-40")
    pypdf_encrypted("pypdf-rc4-128.pdf", "Written by pypdf: RC4 128-bit", "pypdf-rc4-128", "RC4-128")
    pypdf_encrypted("pypdf-aes-128.pdf", "Written by pypdf: AES-128", "pypdf-aes-128", "AES-128")
    pypdf_encrypted("pypdf-aes-256-r5.pdf", "Written by pypdf: AES-256 R5", "pypdf-aes-256-r5", "AES-256-R5")
    pypdf_encrypted("pypdf-aes-256.pdf", "Written by pypdf: AES-256 R6", "pypdf-aes-256", "AES-256")

    def reportlab_encrypted(name: str, description: str, strength: int) -> None:
        from reportlab.lib.pdfencrypt import StandardEncryption
        from reportlab.pdfgen import canvas

        encryption = StandardEncryption("user", ownerPassword="owner", canPrint=1, canModify=0, canCopy=0,
                                        canAnnotate=0, strength=strength)
        pdf = canvas.Canvas(str(HERE / name), pagesize=(300, 200), encrypt=encryption, invariant=1)
        for number in range(1, 4):
            pdf.setFont("Helvetica", 14)
            pdf.drawString(24, 150, f"PDF Key fixture reportlab-{strength} page {number} of 3")
            pdf.showPage()
        pdf.save()
        record(name, description, user="user", owner="owner", tags=("reportlab",))

    reportlab_encrypted("reportlab-rc4-40.pdf", "Written by ReportLab: RC4 40-bit", 40)
    reportlab_encrypted("reportlab-rc4-128.pdf", "Written by ReportLab: RC4 128-bit", 128)

    # --- leading junk before the header (offsets are relative to %PDF-) ---------------------
    body = (HERE / "aes-256-r6.pdf").read_bytes()
    (HERE / "junk-prefix-r6.pdf").write_bytes(b"MIME-Version: 1.0\r\nX-Junk: yes\r\n\r\n" + body)
    record("junk-prefix-r6.pdf", "AES-256 with bytes before the %PDF- header", user="user", owner="owner",
           tags=("junk-prefix",))

    # --- non-ASCII passwords ------------------------------------------------------------------
    # R6, compliant writer: the stored password is SASLprep(typed). The typed form mixes CJK,
    # full-width letters (NFKC folds them to ASCII), a soft hyphen (mapped to nothing), an
    # ideographic space (mapped to U+0020) and a Roman numeral (NFKC: "IX").
    typed = "\u5bc6\u7801\uff30\uff41\uff53\uff53\u00adword\u3000\u2168"
    prepared = "\u5bc6\u7801Password IX"
    save(build_document("unicode-saslprep"), "unicode-saslprep-r6.pdf",
         encryption=Encryption(user=prepared, owner=prepared + "-owner", R=6))
    record("unicode-saslprep-r6.pdf", "AES-256, password stored as SASLprep(typed)", user=typed,
           owner=typed + "-owner", user_bytes=prepared.encode("utf-8"),
           owner_bytes=(prepared + "-owner").encode("utf-8"), tags=("unicode",))

    # R6, writer that skips SASLprep: the stored password is the raw UTF-8 of what was typed.
    save(build_document("unicode-raw"), "unicode-raw-r6.pdf",
         encryption=Encryption(user=typed, owner=typed + "-owner", R=6))
    record("unicode-raw-r6.pdf", "AES-256, password stored as raw UTF-8 without SASLprep", user=typed,
           owner=typed + "-owner", tags=("unicode",))

    # R5 with a decomposed (NFD) password stored, typed precomposed.
    stored_nfd = "pa\u0308sswo\u0308rd"
    save(build_document("unicode-nfd"), "unicode-nfd-r5.pdf", encryption=Encryption(user=stored_nfd, owner="owner", R=5))
    record("unicode-nfd-r5.pdf", "AES-256 R5, password stored decomposed (NFD)", user="p\u00e4ssw\u00f6rd",
           owner="owner", user_bytes=stored_nfd.encode("utf-8"), tags=("unicode",))

    # R4 Latin-1 (identical to PDFDocEncoding for these characters).
    save(build_document("latin1"), "latin1-r4.pdf",
         encryption=Encryption(user="P\u00e4ssw\u00f6rd", owner="\u00d6wner", R=4))
    record("latin1-r4.pdf", "AES-128, Latin-1 password", user="P\u00e4ssw\u00f6rd", owner="\u00d6wner",
           tags=("legacy",))

    # R4 with characters where PDFDocEncoding and Windows-1252 disagree.
    euro = "p\u20acss\u2030"
    save(build_document("pdfdoc"), "pdfdoc-r4.pdf", encryption=Encryption(user=euro, owner=euro + "o", R=4))
    assert euro.encode("pdfdoc") == bytes([0x70, 0xA0, 0x73, 0x73, 0x8B])
    record("pdfdoc-r4.pdf", "AES-128, password in PDFDocEncoding (euro = 0xA0)", user=euro, owner=euro + "o",
           tags=("legacy",))

    def legacy_bytes(name, description, label, R, typed_user, codec, aes=False):
        raw = typed_user.encode(codec)
        owner_raw = raw + b"-owner"
        as_pdfdoc = raw.decode("pdfdoc")  # the str whose PDFDocEncoding is exactly `raw`
        save(build_document(label), name,
             encryption=Encryption(user=as_pdfdoc, owner=owner_raw.decode("pdfdoc"), R=R, aes=aes, metadata=aes))
        record(name, description, user=typed_user, owner=typed_user + "-owner", user_bytes=raw,
               owner_bytes=owner_raw, tags=("legacy",))

    legacy_bytes("cp1252-r3.pdf", "RC4-128, password bytes in Windows-1252 (euro = 0x80)", "cp1252", 3, euro, "cp1252")
    legacy_bytes("utf8-r4.pdf", "AES-128, password bytes in UTF-8 (non-compliant writer)", "utf8-r4", 4,
                 "P\u00e4ssw\u00f6rd", "utf-8", aes=True)
    legacy_bytes("gbk-r3.pdf", "RC4-128, password bytes are GBK-encoded Chinese", "gbk", 3,
                 "\u4e2d\u6587\u5bc6\u7801", "gbk")
    legacy_bytes("big5-r3.pdf", "RC4-128, password bytes are Big5-encoded Chinese", "big5", 3,
                 "\u5bc6\u78bc\u5341", "big5")
    legacy_bytes("sjis-r4.pdf", "AES-128, password bytes are Shift_JIS-encoded Japanese", "sjis", 4,
                 "\u30d1\u30b9\u30ef\u30fc\u30c9\u79d8\u5bc6", "shift_jis", aes=True)
    legacy_bytes("euckr-r3.pdf", "RC4-128, password bytes are EUC-KR-encoded Korean", "euckr", 3,
                 "\ube44\ubc00\ubc88\ud638", "euc-kr")
    legacy_bytes("cp1251-r3.pdf", "RC4-128, password bytes are Windows-1251-encoded Russian", "cp1251", 3,
                 "\u043f\u0430\u0440\u043e\u043b\u044c", "cp1251")

    # A password longer than the 32 bytes R4 looks at: only the first 32 count.
    long_password = "0123456789abcdefghijklmnopqrstuvwxyz-long"
    save(build_document("long-r4"), "long-password-r4.pdf",
         encryption=Encryption(user=long_password, owner="owner", R=4))
    record("long-password-r4.pdf", "AES-128, password longer than the 32 significant bytes", user=long_password,
           owner="owner", tags=("long",))

    # --- line endings (hand-written, exercises the tokenizer on CR and CRLF files) ------------
    for name, eol, label in (("crlf-plain.pdf", b"\r\n", "crlf"), ("cr-plain.pdf", b"\r", "cr")):
        (HERE / name).write_bytes(raw_pdf(simple_objects(label, 3, eol), eol=eol))
        record(name, f"Unencrypted, hand-written with {label.upper()} line endings", tags=("plain", "eol"))

    # --- damaged but recoverable ----------------------------------------------------------------
    def break_startxref(source: str, target: str) -> None:
        data = (HERE / source).read_bytes()
        marker = data.rindex(b"startxref")
        (HERE / target).write_bytes(data[:marker] + b"startxref\n7\n%%EOF\n")

    break_startxref("plain.pdf", "damaged-recoverable.pdf")
    record("damaged-recoverable.pdf", "Unencrypted with a wrong startxref offset (qpdf rebuilds the table)",
           expect_warnings=True, tags=("plain", "damaged"))
    break_startxref("aes-128-r4.pdf", "damaged-recoverable-r4.pdf")
    record("damaged-recoverable-r4.pdf", "AES-128 with a wrong startxref offset", user="user", owner="owner",
           expect_warnings=True, tags=("damaged",))

    # --- errors -----------------------------------------------------------------------------------
    plain_bytes = (HERE / "plain.pdf").read_bytes()
    (HERE / "damaged-unrecoverable.pdf").write_bytes(plain_bytes[:700])
    record_error("damaged-unrecoverable.pdf", "A PDF cut off after 700 bytes: nothing to recover", "damaged")

    (HERE / "not-a-pdf.bin").write_bytes(
        b"\x89PNG\r\n\x1a\n" + bytes(random.Random("not-a-pdf").getrandbits(8) for _ in range(3000))
    )
    record_error("not-a-pdf.bin", "Not a PDF at all", "not-pdf")

    (HERE / "text-not-pdf.bin").write_bytes(b"Hello, this is a plain text file.\n" * 50)
    record_error("text-not-pdf.bin", "A text file", "not-pdf")

    file_id = b"/ID [ <00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff> ]"
    pubsec = simple_objects("pubsec", 2) + [
        b"<< /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s4 /V 2 /Length 128 "
        b"/Recipients [ <3082010a0282010100> ] >>"
    ]
    (HERE / "nonstandard-handler.pdf").write_bytes(
        raw_pdf(pubsec, trailer_extra=b"/Encrypt %d 0 R %s" % (len(pubsec), file_id))
    )
    record_error("nonstandard-handler.pdf", "Certificate (public-key) security handler", "unsupported-encryption",
                 password="anything")

    future = simple_objects("future", 2) + [
        b"<< /Filter /Standard /V 6 /R 7 /Length 256 /P -4 /O <%s> /U <%s> >>" % (b"00" * 48, b"00" * 48)
    ]
    (HERE / "unsupported-revision.pdf").write_bytes(
        raw_pdf(future, trailer_extra=b"/Encrypt %d 0 R %s" % (len(future), file_id), version=b"2.0")
    )
    record_error("unsupported-revision.pdf", "Standard handler with an unknown revision (R7/V6)",
                 "unsupported-encryption", password="anything")

    write_saslprep_vectors()
    (HERE / "manifest.json").write_text(json.dumps(MANIFEST, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    total = sum(p.stat().st_size for p in HERE.glob("*.pdf")) + sum(p.stat().st_size for p in HERE.glob("*.bin"))
    print(f"{len(MANIFEST)} fixtures, {total / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
