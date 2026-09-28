#!/usr/bin/env bash
# Assemble / refresh dist/windows/ with a fresh PhoneControl.exe (no MSI).
#
# Committed tree already contains README, Start-PhoneControl.ps1, .env.example,
# and vendor/*/README placeholders. This script only builds + copies the exe.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="${PHONECONTROL_WINDOWS_TARGET:-x86_64-pc-windows-gnu}"
PROFILE="${PHONECONTROL_CARGO_PROFILE:-release}"
DIST="${PHONECONTROL_WINDOWS_DIST:-dist/windows}"
BUILD="${PHONECONTROL_SKIP_BUILD:-0}"

if [[ "$BUILD" != "1" ]]; then
  bash "$ROOT/scripts/build-windows.sh"
fi

EXE_SRC="target/${TARGET}/${PROFILE}/phonecontrol-agent.exe"
if [[ ! -f "$EXE_SRC" ]]; then
  echo "error: missing $EXE_SRC — run scripts/build-windows.sh first" >&2
  exit 1
fi

mkdir -p "$DIST/vendor/adb" "$DIST/vendor/scrcpy"
cp -f "$EXE_SRC" "$DIST/PhoneControl.exe"

# Ensure placeholder docs exist (fresh clone / zip)
for f in README.md Start-PhoneControl.ps1 run.bat .env.example \
         vendor/adb/README.md vendor/scrcpy/README.md; do
  if [[ ! -f "$DIST/$f" ]]; then
    echo "error: missing committed pack file: $DIST/$f" >&2
    exit 1
  fi
done

echo "==> packaged $DIST"
ls -lh "$DIST/PhoneControl.exe"
find "$DIST" -maxdepth 3 \( -type f -o -type d \) | sort
echo "OK: copy $DIST to a Windows USB host and follow $DIST/README.md"
