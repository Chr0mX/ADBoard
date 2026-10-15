#!/usr/bin/env bash
# Assemble / refresh dist/windows/ with a fresh ADBoard.exe (no MSI).
#
# Builds the same-origin control page into dist/windows/ui and copies
# ADBoard.exe beside it. README, run.bat, and vendor placeholders stay committed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="${PHONECONTROL_WINDOWS_TARGET:-x86_64-pc-windows-gnu}"
PROFILE="${PHONECONTROL_CARGO_PROFILE:-release}"
DIST="${PHONECONTROL_WINDOWS_DIST:-dist/windows}"
BUILD="${PHONECONTROL_SKIP_BUILD:-0}"

if [[ "${PHONECONTROL_SKIP_UI:-0}" != "1" ]]; then
  echo "==> static control UI (same origin as the agent)"
  PHONECONTROL_STATIC_EXPORT=1 NEXT_PUBLIC_AGENT_URL=same \
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

mkdir -p "$DIST/vendor/adb" "$DIST/vendor/scrcpy"
cp -f "$EXE_SRC" "$DIST/ADBoard.exe"

# Ensure placeholder docs exist (fresh clone / zip)
for f in README.md Start-ADBoard.ps1 run.bat .env.example \
         vendor/adb/README.md vendor/scrcpy/README.md; do
  if [[ ! -f "$DIST/$f" ]]; then
    echo "error: missing committed pack file: $DIST/$f" >&2
    exit 1
  fi
done

echo "==> packaged $DIST"
ls -lh "$DIST/ADBoard.exe"
find "$DIST" -maxdepth 3 \( -type f -o -type d \) | sort
echo "OK: copy $DIST to a Windows USB host and follow $DIST/README.md"
