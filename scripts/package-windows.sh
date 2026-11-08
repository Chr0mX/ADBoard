#!/usr/bin/env bash
# Assemble / refresh dist/windows/ with a fresh ADBoard.exe (no MSI).
#
# Builds the same-origin control page into dist/windows/ui and copies
# ADBoard.exe beside it. README, run.bat, and vendor placeholders stay committed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="${ADBOARD_WINDOWS_TARGET:-x86_64-pc-windows-gnu}"
PROFILE="${ADBOARD_CARGO_PROFILE:-release}"
DIST="${ADBOARD_WINDOWS_DIST:-dist/windows}"
BUILD="${ADBOARD_SKIP_BUILD:-0}"

if [[ "${ADBOARD_SKIP_UI:-0}" != "1" ]]; then
  echo "==> static control UI (same origin as the agent)"
  ADBOARD_STATIC_EXPORT=1 NEXT_PUBLIC_AGENT_URL=same \
    npx next build --webpack
  rm -rf "$DIST/ui"
  mkdir -p "$DIST/ui"
  cp -a "$ROOT/out/." "$DIST/ui/"
  test -f "$DIST/ui/index.html"
fi

if [[ "$BUILD" != "1" ]]; then
  bash "$ROOT/scripts/build-windows.sh"
fi

EXE_SRC="target/${TARGET}/${PROFILE}/adboard-agent.exe"
if [[ ! -f "$EXE_SRC" ]]; then
  echo "error: missing $EXE_SRC — run scripts/build-windows.sh first" >&2
  exit 1
fi

# Refuse an exe that is older than the code it should contain. With
# ADBOARD_SKIP_BUILD=1 this script copies whatever is in target/, and an old
# build there would silently ship an agent without the latest fixes.
if [[ "${ADBOARD_ALLOW_STALE_EXE:-0}" != "1" ]]; then
  newer_src="$(find crates -name '*.rs' -newer "$EXE_SRC" -print -quit 2>/dev/null || true)"
  if [[ -z "$newer_src" && Cargo.lock -nt "$EXE_SRC" ]]; then newer_src="Cargo.lock"; fi
  if [[ -n "$newer_src" ]]; then
    echo "error: $EXE_SRC is older than $newer_src — it does not contain the current agent." >&2
    echo "       Run scripts/build-windows.sh (or leave ADBOARD_SKIP_BUILD unset)." >&2
    echo "       To pack it anyway: ADBOARD_ALLOW_STALE_EXE=1" >&2
    exit 1
  fi
fi

mkdir -p "$DIST/vendor/adb" "$DIST/vendor/scrcpy" "$DIST/vendor/ocr"
cp -f "$EXE_SRC" "$DIST/ADBoard.exe"

# Ensure placeholder docs exist (fresh clone / zip)
for f in README.md Start-ADBoard.ps1 run.bat .env.example \
         vendor/adb/README.md vendor/scrcpy/README.md vendor/ocr/README.md; do
  if [[ ! -f "$DIST/$f" ]]; then
    echo "error: missing committed pack file: $DIST/$f" >&2
    exit 1
  fi
done

# Record what went into this pack, so a folder on a USB stick can be traced.
{
  echo "ADBoard Windows pack"
  echo "built:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "commit:     $(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo ' (with uncommitted changes)')"
  echo "rustc:      $(rustc --version 2>/dev/null || echo unknown)"
  echo "node:       $(node --version 2>/dev/null || echo unknown)"
  echo "ui cache:   $(sed -n 's/^const CACHE_VERSION = "\(.*\)";.*/\1/p' "$DIST/ui/sw.js" 2>/dev/null | head -1)"
  echo "ui/m cache:  $(sed -n 's/^const CACHE_VERSION = "\(.*\)";.*/\1/p' "$DIST/ui/m/sw.js" 2>/dev/null | head -1)"
  echo "exe sha256: $(sha256sum "$DIST/ADBoard.exe" | cut -d' ' -f1)"
} > "$DIST/BUILD.txt"

echo "==> packaged $DIST"
ls -lh "$DIST/ADBoard.exe"
find "$DIST" -maxdepth 3 \( -type f -o -type d \) | sort
bash "$ROOT/scripts/verify-pack.sh" "$DIST"
echo "OK: copy $DIST to a Windows USB host and follow $DIST/README.md"
