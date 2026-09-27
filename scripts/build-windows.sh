#!/usr/bin/env bash
# Cross-compile phonecontrol-agent for Windows (x86_64-pc-windows-gnu).
# Produces: target/x86_64-pc-windows-gnu/release/phonecontrol-agent.exe
#
# Requires on the build host:
#   - rustup target: x86_64-pc-windows-gnu
#   - MinGW linker:  x86_64-w64-mingw32-gcc  (Debian/Ubuntu: gcc-mingw-w64-x86-64)
#
# MSVC (x86_64-pc-windows-msvc) is not used here — it needs a Windows SDK / wine-msvc
# setup. Prefer gnu for Linux CI and Linux → Windows packaging.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="${PHONECONTROL_WINDOWS_TARGET:-x86_64-pc-windows-gnu}"
PROFILE="${PHONECONTROL_CARGO_PROFILE:-release}"

if ! command -v rustup >/dev/null 2>&1; then
  echo "error: rustup not found" >&2
  exit 1
fi

rustup target add "$TARGET" >/dev/null

if [[ "$TARGET" == *windows-gnu ]]; then
  if ! command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
    echo "error: x86_64-w64-mingw32-gcc not found" >&2
    echo "  Debian/Ubuntu: sudo apt-get install -y gcc-mingw-w64-x86-64" >&2
    echo "  Then: rustup target add x86_64-pc-windows-gnu" >&2
    exit 1
  fi
fi

echo "==> cargo build -p phonecontrol-agent --${PROFILE} --target ${TARGET}"
cargo build -p phonecontrol-agent --"${PROFILE}" --target "${TARGET}"

EXE="target/${TARGET}/${PROFILE}/phonecontrol-agent.exe"
if [[ ! -f "$EXE" ]]; then
  echo "error: expected artifact missing: $EXE" >&2
  exit 1
fi

ls -lh "$EXE"
file "$EXE" 2>/dev/null || true
echo "OK: $EXE"
