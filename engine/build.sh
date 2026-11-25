#!/usr/bin/env bash
#
# Builds the PDF engine: qpdf + zlib + libjpeg + the pdfx wrapper -> WebAssembly.
#
#   engine/build.sh            incremental build (stages whose inputs are unchanged are skipped)
#   engine/build.sh --clean    remove engine/build first
#
# Output: src/engine/dist/{pdfx.mjs,pdfx.wasm,pdfx.d.mts,BUILDINFO.json}
#
# Environment:
#   PDFX_CACHE_DIR   directory holding the source tarballs      (default: engine/.cache)
#   PDFX_BUILD_DIR   scratch directory                          (default: engine/build)
#   PDFX_DIST_DIR    where the result is installed              (default: src/engine/dist)
#   PDFX_JOBS        parallel compile jobs                      (default: number of CPUs)
#   PDFX_OPT         optimisation level                         (default: -O3)
#   PDFX_LTO         1 = link-time optimisation                 (default: 0)
#   PDFX_OFFLINE     1 = never download, the cache must already hold every tarball
#   PDFX_ALLOW_EMCC_MISMATCH  1 = build with an Emscripten version other than the pinned one
#   EM_CONFIG / PATH / EMSDK  an existing Emscripten install is used as it is found
#
set -euo pipefail

# ----------------------------------------------------------------------------------------------
# Pinned inputs. This block is the single place where versions and checksums live.
# ----------------------------------------------------------------------------------------------
EMSCRIPTEN_VERSION="7.0.1"

QPDF_VERSION="12.4.2"
QPDF_SHA256="8a58af5b6141319287c1883bec8bd1bd545b7567b7fc5e6ce5d25a1c85f36397"
QPDF_FILE="qpdf-${QPDF_VERSION}.tar.gz"
QPDF_URLS=(
  "https://github.com/qpdf/qpdf/releases/download/v${QPDF_VERSION}/qpdf-${QPDF_VERSION}.tar.gz"
  "https://downloads.sourceforge.net/project/qpdf/qpdf/${QPDF_VERSION}/qpdf-${QPDF_VERSION}.tar.gz"
  "https://deb.debian.org/debian/pool/main/q/qpdf/qpdf_${QPDF_VERSION}.orig.tar.gz"
)

ZLIB_VERSION="1.4"
ZLIB_SHA256="02dd159783677a749c04adbdd02b55b8a2bcc7e054f51b76b549199a916ad584"
ZLIB_FILE="zlib-${ZLIB_VERSION}.tar.gz"
ZLIB_URLS=(
  "https://zlib.net/zlib-${ZLIB_VERSION}.tar.gz"
  "https://zlib.net/fossils/zlib-${ZLIB_VERSION}.tar.gz"
  "https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.gz"
)

JPEG_VERSION="9f"
JPEG_SHA256="04705c110cb2469caa79fb71fba3d7bf834914706e9641a4589485c1f832565b"
JPEG_FILE="jpegsrc.v${JPEG_VERSION}.tar.gz"
JPEG_URLS=(
  "https://www.ijg.org/files/jpegsrc.v${JPEG_VERSION}.tar.gz"
  "https://storage.googleapis.com/webassembly/emscripten-ports/jpegsrc.v${JPEG_VERSION}.tar.gz"
)

# ----------------------------------------------------------------------------------------------
# Flags. Everything is compiled with native WebAssembly exceptions; mixing exception models
# between the libraries and the wrapper does not link.
# ----------------------------------------------------------------------------------------------
# -O3 without LTO is the measured optimum: LTO made the module 14 % larger and no faster, -Os and
# -O2 are slower where it matters (see engine/README.md, "Build variants").
OPT_LEVEL="${PDFX_OPT:--O3}"
LTO="${PDFX_LTO:-0}"
COMPILE_FLAGS=("$OPT_LEVEL" -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -DNDEBUG)
if [[ "$LTO" == "1" ]]; then
  COMPILE_FLAGS+=(-flto)
fi

EXPORTED_FUNCTIONS="_pdfx_inspect,_pdfx_process,_pdfx_free,_pdfx_version,_malloc,_free"
EXPORTED_RUNTIME="HEAPU8"

LINK_FLAGS=(
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createPdfx
  -sENVIRONMENT=web,worker
  -sFILESYSTEM=0
  -sALLOW_MEMORY_GROWTH=1
  -sMAXIMUM_MEMORY=4GB
  -sINITIAL_MEMORY=32MB
  -sSTACK_SIZE=8MB
  -sABORTING_MALLOC=0
  -sMALLOC=dlmalloc
  -sTEXTDECODER=2
  -sDYNAMIC_EXECUTION=0
  -sINCOMING_MODULE_JS_API=instantiateWasm
  "-sEXPORTED_FUNCTIONS=${EXPORTED_FUNCTIONS}"
  "-sEXPORTED_RUNTIME_METHODS=${EXPORTED_RUNTIME}"
  --no-entry
)

# ----------------------------------------------------------------------------------------------
ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$ENGINE_DIR")"
CACHE_DIR="${PDFX_CACHE_DIR:-$ENGINE_DIR/.cache}"
BUILD_DIR="${PDFX_BUILD_DIR:-$ENGINE_DIR/build}"
DIST_DIR="${PDFX_DIST_DIR:-$REPO_DIR/src/engine/dist}"
JOBS="${PDFX_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)}"

SRC_DIR="$BUILD_DIR/src"
DEPS_DIR="$BUILD_DIR/deps"
OBJ_DIR="$BUILD_DIR/obj"

log() { printf '\033[1m[pdfx]\033[0m %s\n' "$*" >&2; }
die() { printf '[pdfx] error: %s\n' "$*" >&2; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# fetch <file name> <sha256> <url>...   -> leaves a verified tarball in $CACHE_DIR
fetch() {
  local file="$1" sha="$2"
  shift 2
  local dest="$CACHE_DIR/$file"
  if [[ -f "$dest" ]]; then
    if [[ "$(sha256_of "$dest")" == "$sha" ]]; then
      return 0
    fi
    log "$file in the cache has the wrong checksum; downloading again"
    rm -f "$dest"
  fi
  [[ "${PDFX_OFFLINE:-0}" == "1" ]] && die "$file is missing from $CACHE_DIR and PDFX_OFFLINE=1"
  local url tmp="$dest.part"
  for url in "$@"; do
    log "downloading $url"
    if curl --fail --location --silent --show-error --retry 2 --connect-timeout 20 \
        --output "$tmp" "$url"; then
      if [[ "$(sha256_of "$tmp")" == "$sha" ]]; then
        mv "$tmp" "$dest"
        return 0
      fi
      log "checksum mismatch for $url"
    fi
    rm -f "$tmp"
  done
  die "could not download $file with sha256 $sha from any mirror"
}

# A stage is rebuilt when the hash of its inputs differs from the recorded stamp.
stamp_hash() { printf '%s\n' "$@" | sha256sum | cut -d' ' -f1; }
stage_fresh() { [[ -f "$BUILD_DIR/stamps/$1" && "$(cat "$BUILD_DIR/stamps/$1")" == "$2" ]]; }
stage_done() { mkdir -p "$BUILD_DIR/stamps"; printf '%s' "$2" >"$BUILD_DIR/stamps/$1"; }

# compile_c <object dir> <extra flags...> -- <sources...>   (parallel, C only)
compile_c() {
  local out="$1"
  shift
  local flags=()
  while [[ "$1" != "--" ]]; do
    flags+=("$1")
    shift
  done
  shift
  mkdir -p "$out"
  printf '%s\0' "$@" | xargs -0 -P "$JOBS" -I{} sh -c \
    'src="$1"; out="$2"; shift 2; exec emcc "$@" -c "$src" -o "$out/$(basename "$src" .c).o"' \
    sh {} "$out" "${COMPILE_FLAGS[@]}" "${flags[@]}"
}

# ----------------------------------------------------------------------------------------------
if [[ "${1:-}" == "--clean" ]]; then
  log "removing $BUILD_DIR"
  rm -rf "$BUILD_DIR"
fi

command -v emcc >/dev/null 2>&1 || die "emcc not found: activate Emscripten ${EMSCRIPTEN_VERSION} first"
EMCC_VERSION_LINE="$(emcc --version | head -n1)"
EMCC_VERSION="$(sed -E 's/.*\) ([0-9]+\.[0-9]+\.[0-9]+).*/\1/' <<<"$EMCC_VERSION_LINE")"
if [[ "$EMCC_VERSION" != "$EMSCRIPTEN_VERSION" ]]; then
  if [[ "${PDFX_ALLOW_EMCC_MISMATCH:-0}" == "1" ]]; then
    log "warning: building with Emscripten $EMCC_VERSION (pinned: $EMSCRIPTEN_VERSION)"
  else
    die "Emscripten $EMSCRIPTEN_VERSION required, found $EMCC_VERSION (PDFX_ALLOW_EMCC_MISMATCH=1 to override)"
  fi
fi

mkdir -p "$CACHE_DIR" "$SRC_DIR" "$DEPS_DIR/include" "$DEPS_DIR/lib" "$OBJ_DIR" "$DIST_DIR"
log "emscripten $EMCC_VERSION, $JOBS jobs, lto=$LTO"
FLAG_ID="$(stamp_hash "$EMCC_VERSION_LINE" "${COMPILE_FLAGS[@]}")"

# --- sources ----------------------------------------------------------------------------------
fetch "$QPDF_FILE" "$QPDF_SHA256" "${QPDF_URLS[@]}"
fetch "$ZLIB_FILE" "$ZLIB_SHA256" "${ZLIB_URLS[@]}"
fetch "$JPEG_FILE" "$JPEG_SHA256" "${JPEG_URLS[@]}"

extract() { # <tarball> <sha> <directory name inside the tarball>
  local id
  id="$(stamp_hash "$2")"
  if ! stage_fresh "extract-$3" "$id" || [[ ! -d "$SRC_DIR/$3" ]]; then
    log "extracting $1"
    rm -rf "${SRC_DIR:?}/$3"
    tar -xzf "$CACHE_DIR/$1" -C "$SRC_DIR"
    [[ -d "$SRC_DIR/$3" ]] || die "$1 did not contain $3/"
    stage_done "extract-$3" "$id"
  fi
}
extract "$QPDF_FILE" "$QPDF_SHA256" "qpdf-${QPDF_VERSION}"
extract "$ZLIB_FILE" "$ZLIB_SHA256" "zlib-${ZLIB_VERSION}"
extract "$JPEG_FILE" "$JPEG_SHA256" "jpeg-${JPEG_VERSION}"

QPDF_SRC="$SRC_DIR/qpdf-${QPDF_VERSION}"
ZLIB_SRC="$SRC_DIR/zlib-${ZLIB_VERSION}"
JPEG_SRC="$SRC_DIR/jpeg-${JPEG_VERSION}"

# --- zlib -------------------------------------------------------------------------------------
# Compiled directly: only the in-memory deflate/inflate core is needed (no gz* file API), and it
# needs no configuration step.
ZLIB_ID="$(stamp_hash "$FLAG_ID" "$ZLIB_SHA256")"
if ! stage_fresh zlib "$ZLIB_ID"; then
  log "building zlib $ZLIB_VERSION"
  rm -rf "$OBJ_DIR/zlib" "$DEPS_DIR/lib/libz.a"
  compile_c "$OBJ_DIR/zlib" -DHAVE_UNISTD_H -DHAVE_STDARG_H -- \
    "$ZLIB_SRC"/{adler32,compress,crc32,deflate,infback,inffast,inflate,inftrees,trees,uncompr,zutil}.c
  emar rcs "$DEPS_DIR/lib/libz.a" "$OBJ_DIR"/zlib/*.o
  cp "$ZLIB_SRC/zlib.h" "$ZLIB_SRC/zconf.h" "$DEPS_DIR/include/"
  stage_done zlib "$ZLIB_ID"
fi

# --- libjpeg ----------------------------------------------------------------------------------
# qpdf links against libjpeg for DCT streams. The library sources are compiled directly with the
# fixed jconfig.h in engine/src (ANSI C, no memory backing store); the cjpeg/djpeg tools are not built.
JPEG_ID="$(stamp_hash "$FLAG_ID" "$JPEG_SHA256" "$(sha256_of "$ENGINE_DIR/src/jconfig.h")")"
if ! stage_fresh jpeg "$JPEG_ID"; then
  log "building libjpeg $JPEG_VERSION"
  rm -rf "$OBJ_DIR/jpeg" "$DEPS_DIR/lib/libjpeg.a"
  cp "$ENGINE_DIR/src/jconfig.h" "$JPEG_SRC/jconfig.h"
  JPEG_SOURCES=(
    jaricom jcapimin jcapistd jcarith jccoefct jccolor jcdctmgr jchuff jcinit jcmainct jcmarker
    jcmaster jcomapi jcparam jcprepct jcsample jctrans jdapimin jdapistd jdarith jdatadst jdatasrc
    jdcoefct jdcolor jddctmgr jdhuff jdinput jdmainct jdmarker jdmaster jdmerge jdpostct jdsample
    jdtrans jerror jfdctflt jfdctfst jfdctint jidctflt jidctfst jidctint jquant1 jquant2 jutils
    jmemmgr jmemnobs
  )
  JPEG_PATHS=()
  for name in "${JPEG_SOURCES[@]}"; do JPEG_PATHS+=("$JPEG_SRC/$name.c"); done
  compile_c "$OBJ_DIR/jpeg" -- "${JPEG_PATHS[@]}"
  emar rcs "$DEPS_DIR/lib/libjpeg.a" "$OBJ_DIR"/jpeg/*.o
  cp "$JPEG_SRC"/{jpeglib.h,jmorecfg.h,jerror.h,jconfig.h} "$DEPS_DIR/include/"
  stage_done jpeg "$JPEG_ID"
fi

# --- qpdf -------------------------------------------------------------------------------------
# Static library only. Native crypto (no OpenSSL/GnuTLS). SKIP_OS_SECURE_RANDOM removes the
# /dev/urandom reader and USE_INSECURE_RANDOM stays off, so qpdf has no built-in random source at
# all: the wrapper installs one backed by getentropy(), and without it qpdf throws instead of
# falling back to a weak generator.
QPDF_BUILD="$BUILD_DIR/qpdf"
QPDF_ID="$(stamp_hash "$FLAG_ID" "$QPDF_SHA256" "$ZLIB_ID" "$JPEG_ID")"
if ! stage_fresh qpdf "$QPDF_ID"; then
  log "configuring qpdf $QPDF_VERSION"
  rm -rf "$QPDF_BUILD"
  emcmake cmake -S "$QPDF_SRC" -B "$QPDF_BUILD" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="${COMPILE_FLAGS[*]}" \
    -DCMAKE_CXX_FLAGS="${COMPILE_FLAGS[*]}" \
    -DCMAKE_C_FLAGS_RELEASE="" \
    -DCMAKE_CXX_FLAGS_RELEASE="" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_STATIC_LIBS=ON \
    -DBUILD_DOC=OFF \
    -DUSE_IMPLICIT_CRYPTO=OFF \
    -DREQUIRE_CRYPTO_NATIVE=ON \
    -DSKIP_OS_SECURE_RANDOM=ON \
    -DUSE_INSECURE_RANDOM=OFF \
    -DZLIB_H_PATH="$DEPS_DIR/include" \
    -DZLIB_LIB_PATH="$DEPS_DIR/lib/libz.a" \
    -DLIBJPEG_H_PATH="$DEPS_DIR/include" \
    -DLIBJPEG_LIB_PATH="$DEPS_DIR/lib/libjpeg.a" \
    >"$BUILD_DIR/qpdf-configure.log" 2>&1 || { tail -n 40 "$BUILD_DIR/qpdf-configure.log" >&2; die "qpdf configure failed"; }
  grep -q "Native crypto enabled: ON" "$BUILD_DIR/qpdf-configure.log" || die "qpdf native crypto is not enabled"
  grep -q "#define SKIP_OS_SECURE_RANDOM 1" "$QPDF_BUILD/libqpdf/qpdf/qpdf-config.h" || die "SKIP_OS_SECURE_RANDOM not set"
  if grep -q "#define USE_INSECURE_RANDOM" "$QPDF_BUILD/libqpdf/qpdf/qpdf-config.h"; then
    die "USE_INSECURE_RANDOM must stay off"
  fi
  log "compiling libqpdf (this takes a few minutes)"
  cmake --build "$QPDF_BUILD" --target libqpdf --parallel "$JOBS" \
    >"$BUILD_DIR/qpdf-build.log" 2>&1 || { tail -n 60 "$BUILD_DIR/qpdf-build.log" >&2; die "qpdf build failed"; }
  stage_done qpdf "$QPDF_ID"
fi
QPDF_LIB="$QPDF_BUILD/libqpdf/libqpdf.a"
[[ -f "$QPDF_LIB" ]] || die "$QPDF_LIB was not produced"

# --- wrapper + link ---------------------------------------------------------------------------
log "compiling and linking pdfx"
OUT_DIR="$BUILD_DIR/out"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
em++ "${COMPILE_FLAGS[@]}" -std=c++20 -Wall -Wextra -Werror \
  -DPDFX_ZLIB_VERSION="\"$ZLIB_VERSION\"" -DPDFX_JPEG_VERSION="\"$JPEG_VERSION\"" \
  -I"$QPDF_SRC/include" -I"$DEPS_DIR/include" \
  -c "$ENGINE_DIR/src/pdfx.cc" -o "$OBJ_DIR/pdfx.o"
em++ "${COMPILE_FLAGS[@]}" "${LINK_FLAGS[@]}" \
  --js-library "$ENGINE_DIR/src/pdfx_lib.js" \
  "$OBJ_DIR/pdfx.o" "$QPDF_LIB" "$DEPS_DIR/lib/libjpeg.a" "$DEPS_DIR/lib/libz.a" \
  -o "$OUT_DIR/pdfx.mjs"

# The module must come out without a file system: with -sFILESYSTEM=0 the libc calls qpdf's unused
# file classes reference are stubs that fail. If Emscripten's virtual file system shows up in the
# glue, something pulled it in and the "nothing but the two byte callbacks" property is gone.
if grep -Eq 'MEMFS|FS\.createNode|FS\.mkdir|IDBFS|NODEFS' "$OUT_DIR/pdfx.mjs"; then
  die "the generated glue contains a virtual file system; check the link flags"
fi
grep -q 'pdfxHost' "$OUT_DIR/pdfx.mjs" || die "the generated glue lacks the pdfxHost imports"

install -m 0644 "$OUT_DIR/pdfx.mjs" "$DIST_DIR/pdfx.mjs"
install -m 0644 "$OUT_DIR/pdfx.wasm" "$DIST_DIR/pdfx.wasm"
install -m 0644 "$ENGINE_DIR/src/pdfx.d.mts" "$DIST_DIR/pdfx.d.mts"

json_array() { local IFS=,; local items=(); local x; for x in "$@"; do items+=("\"${x//\"/\\\"}\""); done; printf '[%s]' "${items[*]}"; }
cat >"$DIST_DIR/BUILDINFO.json" <<EOF
{
  "qpdf": "$QPDF_VERSION",
  "zlib": "$ZLIB_VERSION",
  "jpeg": "$JPEG_VERSION",
  "emscripten": "$EMCC_VERSION",
  "sources": {
    "$QPDF_FILE": "$QPDF_SHA256",
    "$ZLIB_FILE": "$ZLIB_SHA256",
    "$JPEG_FILE": "$JPEG_SHA256"
  },
  "compileFlags": $(json_array "${COMPILE_FLAGS[@]}"),
  "linkFlags": $(json_array "${LINK_FLAGS[@]}"),
  "wasmBytes": $(wc -c <"$DIST_DIR/pdfx.wasm" | tr -d ' '),
  "wasmSha256": "$(sha256_of "$DIST_DIR/pdfx.wasm")",
  "glueSha256": "$(sha256_of "$DIST_DIR/pdfx.mjs")"
}
EOF

log "installed into $DIST_DIR"
ls -l "$DIST_DIR" >&2
