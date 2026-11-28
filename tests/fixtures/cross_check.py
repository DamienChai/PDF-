#!/usr/bin/env python3
"""Cross-validation of the WebAssembly engine against other PDF libraries.

    pip install pikepdf pypdf cryptography
    python3 tests/fixtures/cross_check.py [--out DIR] [--skip-driver] [--verbose]

1. Runs the engine over every fixture (tests/fixtures/cross_check.driver.ts, through Vitest):
   decrypt with each password, decrypt + compress + linearize, encrypt with AES-256 and AES-128,
   plus a few variations (Unicode passwords, owner-only, cleartext metadata).
2. Checks every output three ways:
   pikepdf  (native qpdf) opens it with the expected passwords and only those; encryption
            parameters and permissions are as requested; every page's decoded content and every
            attachment equals the original; qpdf's syntax check finds nothing; linearization
            data is valid where requested.
   pypdf    (an independent implementation of the PDF security handlers) agrees on which
            passwords open it and with which rights, on /R, /V, /Length and /P, and extracts the
            same text from every page as from the original.
   native   pikepdf performs the same operation on the same input; the engine's output must
            contain the same objects (same numbering, same dictionaries, same stream data).
            Decrypted 'preserve' outputs are compared on raw stream bytes, the others on
            decoded stream data.

Exits non-zero if anything differs.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import warnings
from collections import Counter

import pikepdf
import pypdf

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent

warnings.filterwarnings("ignore")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Failure(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Failure(message)


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


def expected_allow(permissions: dict) -> pikepdf.Permissions:
    return pikepdf.Permissions(
        accessibility=True,  # cannot be withheld from R4 on (bit 10 is deprecated)
        extract=permissions["extract"],
        modify_annotation=permissions["annotate"],
        modify_assembly=permissions["assemble"],
        modify_form=permissions["fillForms"],
        modify_other=permissions["modify"],
        print_lowres=permissions["print"] != "none",
        print_highres=permissions["print"] == "full",
    )


def opens(path: pathlib.Path, password: bytes) -> bool:
    try:
        pikepdf.open(path, password=password).close()
        return True
    except pikepdf.PasswordError:
        return False


# --------------------------------------------------------------------------------------------
# pikepdf
# --------------------------------------------------------------------------------------------


def check_pikepdf(path: pathlib.Path, entry: dict, source: dict) -> None:
    user = bytes.fromhex(entry["userPasswordHex"]) if entry["userPasswordHex"] is not None else None
    owner = bytes.fromhex(entry["ownerPasswordHex"]) if entry["ownerPasswordHex"] is not None else None
    encrypted = entry["operation"] == "encrypt"

    if encrypted:
        require(opens(path, owner), "the owner password does not open it")
        require(not opens(path, b"definitely-wrong"), "a wrong password opens it")
        require(opens(path, b"") == (user == b""), "opening without a password behaves wrongly")
        if user:
            require(opens(path, user), "the user password does not open it")
    else:
        require(opens(path, b""), "does not open without a password")

    with pikepdf.open(path, password=owner or b"") as pdf:
        require(pdf.is_encrypted == encrypted, f"is_encrypted = {pdf.is_encrypted}")
        require(len(pdf.pages) == source["pageCount"], f"{len(pdf.pages)} pages")
        require(page_hashes(pdf) == source["pageContentSha256"], "page content differs")
        require(attachment_hashes(pdf) == source["attachmentSha256"], "attachments differ")
        problems = pdf.check_pdf_syntax()
        require(not problems, f"qpdf syntax check: {problems[:3]}")
        linearize = bool(entry["output"].get("linearize"))
        require(pdf.is_linearized == linearize, f"is_linearized = {pdf.is_linearized}")
        if linearize:
            log = io.StringIO()
            require(pdf.check_linearization(log), f"linearization data invalid: {log.getvalue()[:200]}")
        if encrypted:
            info = pdf.encryption
            aes256 = entry["algorithm"] == "aes-256"
            require((info.R, info.V, info.bits) == ((6, 5, 256) if aes256 else (4, 4, 128)),
                    f"R/V/bits = {info.R}/{info.V}/{info.bits}")
            method = "aesv3" if aes256 else "aes"
            require(info.stream_method.name == method and info.string_method.name == method,
                    f"methods = {info.stream_method.name}/{info.string_method.name}")
            require(pdf.allow == expected_allow(entry["permissions"]), f"permissions = {pdf.allow}")
            require(pdf.owner_password_matched, "owner password not recognised as owner")
            metadata = bool(pdf.trailer["/Encrypt"].get("/EncryptMetadata", True))
            require(metadata == entry["encryptMetadata"], f"EncryptMetadata = {metadata}")
    if encrypted and user and user != owner:
        with pikepdf.open(path, password=user) as pdf:
            require(pdf.user_password_matched and not pdf.owner_password_matched, "user password access level")


# --------------------------------------------------------------------------------------------
# pypdf
# --------------------------------------------------------------------------------------------


def check_pypdf(path: pathlib.Path, entry: dict, source: dict) -> None:
    encrypted = entry["operation"] == "encrypt"
    reader = pypdf.PdfReader(path)
    require(reader.is_encrypted == encrypted, f"is_encrypted = {reader.is_encrypted}")
    if encrypted:
        user = bytes.fromhex(entry["userPasswordHex"])
        owner = bytes.fromhex(entry["ownerPasswordHex"])
        require(int(pypdf.PdfReader(path).decrypt(b"definitely-wrong")) == 0, "a wrong password opens it")
        if user and user != owner:
            require(int(pypdf.PdfReader(path).decrypt(user)) == 1, "user password is not USER")
        require(int(reader.decrypt(owner)) == 2, "owner password is not OWNER")
        encrypt = reader.trailer["/Encrypt"]
        aes256 = entry["algorithm"] == "aes-256"
        require((int(encrypt["/R"]), int(encrypt["/V"])) == ((6, 5) if aes256 else (4, 4)), "R/V")
        require(int(encrypt["/Length"]) == (256 if aes256 else 128), f"/Length = {encrypt['/Length']}")
        with pikepdf.open(path, password=owner) as pdf:
            require(int(encrypt["/P"]) == pdf.encryption.P, "/P differs between pypdf and qpdf")
        flags = pypdf.constants.UserAccessPermissions(int(encrypt["/P"]) & 0xFFFFFFFF)
        perms = entry["permissions"]
        has = lambda flag: bool(flags & flag)  # noqa: E731
        require(has(pypdf.constants.UserAccessPermissions.PRINT) == (perms["print"] != "none"), "print bit")
        require(has(pypdf.constants.UserAccessPermissions.PRINT_TO_REPRESENTATION) == (perms["print"] == "full"),
                "high-quality print bit")
        require(has(pypdf.constants.UserAccessPermissions.MODIFY) == perms["modify"], "modify bit")
        require(has(pypdf.constants.UserAccessPermissions.EXTRACT) == perms["extract"], "extract bit")
        require(has(pypdf.constants.UserAccessPermissions.ADD_OR_MODIFY) == perms["annotate"], "annotate bit")
        require(has(pypdf.constants.UserAccessPermissions.FILL_FORM_FIELDS) == perms["fillForms"], "form bit")
        require(has(pypdf.constants.UserAccessPermissions.ASSEMBLE_DOC) == perms["assemble"], "assemble bit")
    require(len(reader.pages) == source["pageCount"], f"{len(reader.pages)} pages")
    text = [page.extract_text() for page in reader.pages]
    require(text == source["pageText"], "extracted text differs")


# --------------------------------------------------------------------------------------------
# The same operation with native qpdf
# --------------------------------------------------------------------------------------------


def canonical(pdf: pikepdf.Pdf, raw_streams: bool) -> list[tuple]:
    """Every object of the file in a comparable form, in object-number order."""
    result = []
    for obj in pdf.objects:
        if isinstance(obj, pikepdf.Dictionary) and "/Linearized" in obj:
            continue  # byte offsets: differ as soon as any deflated stream differs by a byte
        if isinstance(obj, pikepdf.Dictionary) and obj.get("/Filter") == "/Standard" and "/O" in obj:
            continue  # the encryption dictionary: random salts (checked field by field elsewhere)
        if isinstance(obj, pikepdf.Stream):
            kind = obj.get("/Type")
            if kind in ("/ObjStm", "/XRef"):
                continue  # freshly deflated containers: bytes depend on the zlib build
            if kind is None and "/S" in obj and "/Subtype" not in obj:
                continue  # linearization hint stream: offsets again
            dictionary = pikepdf.Dictionary(obj.stream_dict)
            for key in ("/Length",) if raw_streams else ("/Length", "/Filter", "/DecodeParms"):
                if key in dictionary:
                    del dictionary[key]
            try:
                data = obj.read_raw_bytes() if raw_streams else obj.read_bytes()
            except pikepdf.PdfError:
                data = obj.read_raw_bytes()
            result.append(("stream", obj.objgen, dictionary.unparse(), sha256(data)))
        else:
            result.append(("object", obj.objgen, obj.unparse(resolved=True)))
    trailer = pikepdf.Dictionary(pdf.trailer)
    for key in ("/ID", "/Encrypt", "/Size", "/Prev", "/Length", "/Filter", "/DecodeParms", "/W", "/Index",
                "/Type", "/XRefStm"):
        if key in trailer:
            del trailer[key]
    result.append(("trailer", trailer.unparse()))
    return result


ID_PATTERN = re.compile(rb"/ID ?\[ ?<[0-9a-fA-F]*> ?<[0-9a-fA-F]*> ?\]")


def check_native(path: pathlib.Path, entry: dict, source: dict, stats: Counter) -> None:
    compress = entry["output"].get("streams") == "compress"
    linearize = bool(entry["output"].get("linearize"))
    source_password = (source["ownerPasswordHex"] or source["userPasswordHex"] or "")
    encryption: pikepdf.Encryption | bool = False
    if entry["operation"] == "encrypt":
        aes256 = entry["algorithm"] == "aes-256"
        codec = "utf-8" if aes256 else "pdfdoc"
        encryption = pikepdf.Encryption(
            user=bytes.fromhex(entry["userPasswordHex"]).decode(codec),
            owner=bytes.fromhex(entry["ownerPasswordHex"]).decode(codec),
            R=6 if aes256 else 4,
            aes=True,
            metadata=entry["encryptMetadata"],
            allow=expected_allow(entry["permissions"]),
        )
    # pikepdf does not allow choosing the decode level together with encryption; it then uses
    # qpdf's default, which decodes what it can. Stream data is compared decoded in that case.
    raw_streams = not compress and encryption is False
    options = {}
    if encryption is False:
        options["stream_decode_level"] = (
            pikepdf.StreamDecodeLevel.generalized if compress else pikepdf.StreamDecodeLevel.none
        )
    native = io.BytesIO()
    with pikepdf.open(HERE / entry["source"], password=bytes.fromhex(source_password)) as pdf:
        pdf.save(
            native,
            encryption=encryption,
            compress_streams=compress,
            object_stream_mode=pikepdf.ObjectStreamMode.generate if compress else pikepdf.ObjectStreamMode.preserve,
            linearize=linearize,
            fix_metadata_version=False,
            **options,
        )
    ours = path.read_bytes()
    theirs = native.getvalue()
    # Without encryption the two files can even be identical once the time-based /ID is masked.
    if entry["operation"] == "decrypt" and ID_PATTERN.sub(b"/ID[]", ours) == ID_PATTERN.sub(b"/ID[]", theirs):
        stats["byte-identical to native qpdf"] += 1
        return
    owner = bytes.fromhex(entry["ownerPasswordHex"]) if entry["ownerPasswordHex"] else b""
    with pikepdf.open(path, password=owner) as a, pikepdf.open(io.BytesIO(theirs), password=owner) as b:
        ca, cb = canonical(a, raw_streams), canonical(b, raw_streams)
        if ca != cb:
            for x, y in zip(ca, cb):
                if x != y:
                    raise Failure(f"object differs from native qpdf:\n    ours   {str(x)[:300]}\n    native {str(y)[:300]}")
            raise Failure(f"{len(ca)} objects, native qpdf has {len(cb)}")
    stats["object-identical to native qpdf"] += 1
    if entry["operation"] == "decrypt":
        stats["size delta vs native (bytes)"] += len(ours) - len(theirs)


# --------------------------------------------------------------------------------------------


def run_driver(out: pathlib.Path) -> None:
    environment = dict(os.environ, PDFKEY_CROSS_OUT=str(out))
    subprocess.run(
        ["npx", "vitest", "run", "--config", "tests/fixtures/cross-check.config.ts"],
        cwd=REPO,
        env=environment,
        check=True,
        stdout=subprocess.DEVNULL,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=pathlib.Path, help="directory for the engine outputs (default: temporary)")
    parser.add_argument("--skip-driver", action="store_true", help="validate the outputs already in --out")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    temporary = None
    if args.out is None:
        temporary = tempfile.TemporaryDirectory(prefix="pdfkey-cross-")
        args.out = pathlib.Path(temporary.name)
    if not args.skip_driver:
        run_driver(args.out)

    manifest = {f["file"]: f for f in json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))}
    index = json.loads((args.out / "index.json").read_text(encoding="utf-8"))
    checks = (("pikepdf", check_pikepdf), ("pypdf", check_pypdf))
    matrix: dict[str, Counter] = {}
    stats: Counter = Counter()
    failures = []
    for entry in index:
        source = manifest[entry["source"]]
        if entry["operation"] == "decrypt":
            kind = "decrypt" + ("+compress+linearize" if entry["output"] else "")
        else:
            kind = f"encrypt {entry['algorithm']}" + ("+compress+linearize" if entry["output"] else "")
        row = matrix.setdefault(kind, Counter())
        row["outputs"] += 1
        path = args.out / entry["file"]
        for name, check in (*checks, ("native", lambda p, e, s: check_native(p, e, s, stats))):
            try:
                check(path, entry, source)
                row[name] += 1
            except Failure as failure:
                failures.append(f"{entry['file']} [{name}]: {failure}")
            except Exception as error:  # noqa: BLE001 - any library error is a failed check
                failures.append(f"{entry['file']} [{name}]: {type(error).__name__}: {error}")
        if args.verbose:
            print(f"  {entry['file']}")

    print(f"pikepdf {pikepdf.__version__} (qpdf {pikepdf.__libqpdf_version__}), pypdf {pypdf.__version__}")
    print(f"{len(index)} engine outputs from {len({e['source'] for e in index})} fixtures\n")
    header = f"{'operation':<40}{'outputs':>8}{'pikepdf':>9}{'pypdf':>7}{'native':>8}"
    print(header)
    print("-" * len(header))
    for kind, row in matrix.items():
        print(f"{kind:<40}{row['outputs']:>8}{row['pikepdf']:>9}{row['pypdf']:>7}{row['native']:>8}")
    print()
    for key, value in stats.items():
        print(f"{key}: {value}")
    if failures:
        print(f"\n{len(failures)} FAILED CHECKS")
        for failure in failures:
            print("  " + failure)
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
