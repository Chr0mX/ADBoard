#!/usr/bin/env bash
# Download ADB (platform-tools) + scrcpy + the OCR models (macro text steps)
# into ./temp/, then install into tools/linux/{adb,scrcpy}/ + tools/ocr/ and/or
# dist/windows/vendor/{adb,scrcpy,ocr}/.
#
# Usage:
#   ./scripts/fetch-deps.sh
#   FETCH_TARGET=windows ./scripts/fetch-deps.sh
#   FETCH_TARGET=all FETCH_FORCE=1 ./scripts/fetch-deps.sh
#
# Env:
#   FETCH_TARGET   linux | windows | all   (default: host OS → linux|windows)
#   FETCH_FORCE    1 to re-download / re-install even if binaries exist
#   SCRCPY_VERSION optional pin (default: latest GitHub release tag without 'v')
#   FETCH_ONLY     ocr to fetch only the OCR models (CI)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="${ROOT}/temp"
PLATFORM_TOOLS_VERSION_MARKER="latest"
SCRCPY_REPO="Genymobile/scrcpy"

log() { printf '+ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

host_target() {
  case "$(uname -s)" in
    Linux*) echo linux ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) echo windows ;;
    *)
      warn "unknown host $(uname -s); defaulting FETCH_TARGET=linux"
      echo linux
      ;;
  esac
}

resolve_targets() {
  local t="${FETCH_TARGET:-$(host_target)}"
  case "$t" in
    linux|windows) echo "$t" ;;
    all) echo "linux windows" ;;
    *) die "FETCH_TARGET must be linux|windows|all (got: $t)" ;;
  esac
}

force_mode() {
  case "${FETCH_FORCE:-0}" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

file_ok() {
  [[ -f "$1" && -s "$1" ]]
}

download() {
  local url="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if file_ok "$dest" && ! force_mode; then
    log "cache hit: $dest"
    return 0
  fi
  log "download: $url"
  curl -fsSL --retry 3 --retry-delay 2 -o "${dest}.partial" "$url"
  mv -f "${dest}.partial" "$dest"
}

extract_zip() {
  local zip="$1" dest="$2"
  rm -rf "$dest"
  mkdir -p "$dest"
  unzip -q "$zip" -d "$dest"
}

extract_tar_gz() {
  local tgz="$1" dest="$2"
  rm -rf "$dest"
  mkdir -p "$dest"
  tar -xzf "$tgz" -C "$dest"
}

latest_scrcpy_tag() {
  if [[ -n "${SCRCPY_VERSION:-}" ]]; then
    local v="${SCRCPY_VERSION#v}"
    echo "v${v}"
    return 0
  fi
  local tag
  tag="$(curl -fsSL "https://api.github.com/repos/${SCRCPY_REPO}/releases/latest" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["tag_name"])')"
  [[ -n "$tag" ]] || die "could not resolve latest scrcpy release"
  echo "$tag"
}

install_linux_adb() {
  local dest_dir="${ROOT}/tools/linux/adb"
  local adb="${dest_dir}/adb"
  if file_ok "$adb" && ! force_mode; then
    log "skip linux adb (present): $adb"
    return 0
  fi
  local zip="${TEMP_DIR}/downloads/platform-tools-linux.zip"
  local extract="${TEMP_DIR}/extract/platform-tools-linux"
  download "https://dl.google.com/android/repository/platform-tools-${PLATFORM_TOOLS_VERSION_MARKER}-linux.zip" "$zip"
  extract_zip "$zip" "$extract"
  mkdir -p "$dest_dir"
  cp -f "${extract}/platform-tools/adb" "$adb"
  chmod +x "$adb"
  # Optional helpers commonly expected next to adb
  for f in fastboot make_f2fs mke2fs; do
    if [[ -f "${extract}/platform-tools/${f}" ]]; then
      cp -f "${extract}/platform-tools/${f}" "${dest_dir}/${f}"
      chmod +x "${dest_dir}/${f}" || true
    fi
  done
  log "installed linux adb → ${adb}"
}

clear_install_dir() {
  # Remove previous install contents but keep README.md / .gitkeep placeholders.
  local dest_dir="$1"
  mkdir -p "$dest_dir"
  find "$dest_dir" -mindepth 1 -maxdepth 1 \
    ! -name 'README.md' ! -name '.gitkeep' \
    -exec rm -rf {} +
}

flatten_release_dir() {
  # Copy contents of archive's single top-level dir into dest.
  local nested="$1" dest_dir="$2"
  shopt -s dotglob nullglob
  cp -a "${nested}/." "${dest_dir}/"
  shopt -u dotglob nullglob
}

normalize_scrcpy_server() {
  local dest_dir="$1"
  if [[ ! -f "${dest_dir}/scrcpy-server" ]]; then
    local srv
    srv="$(find "$dest_dir" -maxdepth 1 -type f -name 'scrcpy-server*' | head -1 || true)"
    if [[ -n "$srv" ]]; then
      cp -f "$srv" "${dest_dir}/scrcpy-server"
    fi
  fi
}

install_linux_scrcpy() {
  local dest_dir="${ROOT}/tools/linux/scrcpy"
  local bin="${dest_dir}/scrcpy"
  local tag ver tgz extract asset nested
  tag="$(latest_scrcpy_tag)"
  ver="${tag#v}"
  if file_ok "$bin" && [[ -f "${dest_dir}/.version" ]] \
    && [[ "$(cat "${dest_dir}/.version")" == "$ver" ]] && ! force_mode; then
    log "skip linux scrcpy (present ${ver}): $bin"
    return 0
  fi
  asset="scrcpy-linux-x86_64-${tag}.tar.gz"
  tgz="${TEMP_DIR}/downloads/${asset}"
  extract="${TEMP_DIR}/extract/scrcpy-linux-${ver}"
  download "https://github.com/${SCRCPY_REPO}/releases/download/${tag}/${asset}" "$tgz"
  extract_tar_gz "$tgz" "$extract"
  # Archives ship a single top-level dir; -mindepth 1 avoids matching $extract itself.
  nested="$(find "$extract" -mindepth 1 -maxdepth 1 -type d -name 'scrcpy-linux-*' | head -1)"
  [[ -n "$nested" ]] || die "scrcpy linux archive layout unexpected under $extract"
  clear_install_dir "$dest_dir"
  flatten_release_dir "$nested" "$dest_dir"
  chmod +x "${dest_dir}/scrcpy" 2>/dev/null || true
  normalize_scrcpy_server "$dest_dir"
  echo "$ver" > "${dest_dir}/.version"
  file_ok "$bin" || die "linux scrcpy binary missing after install: $bin"
  log "installed linux scrcpy ${ver} → ${dest_dir}"
}

install_windows_adb() {
  local dest_dir="${ROOT}/dist/windows/vendor/adb"
  local adb="${dest_dir}/adb.exe"
  if file_ok "$adb" && ! force_mode; then
    log "skip windows adb (present): $adb"
    return 0
  fi
  local zip="${TEMP_DIR}/downloads/platform-tools-windows.zip"
  local extract="${TEMP_DIR}/extract/platform-tools-windows"
  download "https://dl.google.com/android/repository/platform-tools-${PLATFORM_TOOLS_VERSION_MARKER}-windows.zip" "$zip"
  extract_zip "$zip" "$extract"
  mkdir -p "$dest_dir"
  cp -f "${extract}/platform-tools/adb.exe" "$adb"
  for f in AdbWinApi.dll AdbWinUsbApi.dll; do
    [[ -f "${extract}/platform-tools/${f}" ]] && cp -f "${extract}/platform-tools/${f}" "${dest_dir}/${f}"
  done
  log "installed windows adb → ${adb}"
}

install_windows_scrcpy() {
  local dest_dir="${ROOT}/dist/windows/vendor/scrcpy"
  local bin="${dest_dir}/scrcpy.exe"
  local tag ver zip extract asset nested
  tag="$(latest_scrcpy_tag)"
  ver="${tag#v}"
  if file_ok "$bin" && [[ -f "${dest_dir}/.version" ]] \
    && [[ "$(cat "${dest_dir}/.version")" == "$ver" ]] && ! force_mode; then
    log "skip windows scrcpy (present ${ver}): $bin"
    return 0
  fi
  asset="scrcpy-win64-${tag}.zip"
  zip="${TEMP_DIR}/downloads/${asset}"
  extract="${TEMP_DIR}/extract/scrcpy-win64-${ver}"
  download "https://github.com/${SCRCPY_REPO}/releases/download/${tag}/${asset}" "$zip"
  extract_zip "$zip" "$extract"
  nested="$(find "$extract" -mindepth 1 -maxdepth 1 -type d -name 'scrcpy-win64-*' | head -1)"
  [[ -n "$nested" ]] || die "scrcpy windows archive layout unexpected under $extract"
  clear_install_dir "$dest_dir"
  flatten_release_dir "$nested" "$dest_dir"
  normalize_scrcpy_server "$dest_dir"
  echo "$ver" > "${dest_dir}/.version"
  file_ok "$bin" || die "windows scrcpy binary missing after install: $bin"
  log "installed windows scrcpy ${ver} → ${dest_dir}"
}

# ocrs models (https://github.com/robertknight/ocrs-models, Apache-2.0), pinned by checksum.
OCR_MODELS_URL="https://ocrs-models.s3-accelerate.amazonaws.com"
OCR_MODELS=(
  "text-detection.rten f15cfb56bd02c4bf478a20343986504a1f01e1665c2b3a0ad66340f054b1b5ca"
  "text-recognition.rten e484866d4cce403175bd8d00b128feb08ab42e208de30e42cd9889d8f1735a6e"
)

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

install_ocr_models() {
  local dest_dir="$1" entry name sum file
  for entry in "${OCR_MODELS[@]}"; do
    name="${entry%% *}"
    sum="${entry##* }"
    if file_ok "${dest_dir}/${name}" && [[ "$(sha256_of "${dest_dir}/${name}")" == "$sum" ]] && ! force_mode; then
      log "skip ocr model (present): ${dest_dir}/${name}"
      continue
    fi
    file="${TEMP_DIR}/downloads/${name}"
    download "${OCR_MODELS_URL}/${name}" "$file"
    if [[ "$(sha256_of "$file")" != "$sum" ]]; then
      rm -f "$file"
      die "checksum mismatch for ${name} (download removed; run again)"
    fi
    mkdir -p "$dest_dir"
    cp -f "$file" "${dest_dir}/${name}"
    log "installed ocr model → ${dest_dir}/${name}"
  done
}

main() {
  need_cmd curl
  need_cmd unzip
  need_cmd tar
  need_cmd python3
  need_cmd find

  mkdir -p "${TEMP_DIR}/downloads" "${TEMP_DIR}/extract"
  log "temp cache: ${TEMP_DIR}"
  log "targets: $(resolve_targets)"

  for t in $(resolve_targets); do
    case "$t" in
      linux)
        if [[ "${FETCH_ONLY:-}" != "ocr" ]]; then
          install_linux_adb
          install_linux_scrcpy
        fi
        install_ocr_models "${ROOT}/tools/ocr"
        ;;
      windows)
        if [[ "${FETCH_ONLY:-}" != "ocr" ]]; then
          install_windows_adb
          install_windows_scrcpy
        fi
        install_ocr_models "${ROOT}/dist/windows/vendor/ocr"
        ;;
    esac
  done

  log "done. Downloads stay under ./temp/; binaries installed under tools/ and dist/windows/vendor/."
  log "Agent auto-discovers vendored paths (or set ADB_PATH / SCRCPY_PATH / SCRCPY_SERVER_PATH / ADBOARD_OCR_MODELS)."
}

main "$@"
