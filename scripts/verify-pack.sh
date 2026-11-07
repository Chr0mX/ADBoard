#!/usr/bin/env bash
# Check that a Windows pack folder is complete and matches the source tree.
#
#   scripts/verify-pack.sh [dist/windows]
#
# Exit 0 = good to copy to a Windows host. Exit 1 lists what is wrong.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${1:-$ROOT/dist/windows}"
problems=0
fail() { echo "FAIL: $*" >&2; problems=$((problems + 1)); }
ok() { echo "ok:   $*"; }

[[ -d "$DIST" ]] || { echo "FAIL: $DIST is not a folder" >&2; exit 1; }

# 1. Every file the portable folder needs.
for f in ADBoard.exe run.bat Start-ADBoard.ps1 README.md .env.example \
         ui/index.html ui/sw.js \
         vendor/adb/README.md vendor/scrcpy/README.md vendor/ocr/README.md; do
  if [[ -f "$DIST/$f" ]]; then ok "$f"; else fail "missing $f"; fi
done

# 2. The exe is a Windows program of a sensible size.
exe="$DIST/ADBoard.exe"
if [[ -f "$exe" ]]; then
  size=$(stat -c %s "$exe")
  (( size > 5000000 )) && ok "ADBoard.exe is $((size / 1048576)) MiB" || fail "ADBoard.exe is only $size bytes"
  [[ "$(head -c 2 "$exe")" == "MZ" ]] && ok "ADBoard.exe is a Windows executable (MZ header)" || fail "ADBoard.exe has no MZ header"
  # It must be built from the current agent: these routes exist in the source tree.
  for route in "/api/bootstrap" "/api/virtual-display" "/api/device/command"; do
    grep -qa -- "$route" "$exe" && ok "exe serves $route" || fail "exe does not contain $route (built from an older agent?)"
  done
  # And it must not be older than the code it should contain.
  stale=$(find "$ROOT/crates" -name '*.rs' -newer "$exe" -print -quit 2>/dev/null)
  [[ -z "$stale" ]] && ok "exe is newer than every .rs file" || fail "exe is older than ${stale#$ROOT/}: rebuild it"
fi

# 3. The packed page is the page in public/: same service-worker cache version.
want=$(sed -n 's/^const CACHE_VERSION = "\(.*\)";.*/\1/p' "$ROOT/public/sw.js" | head -1)
have=$(sed -n 's/^const CACHE_VERSION = "\(.*\)";.*/\1/p' "$DIST/ui/sw.js" 2>/dev/null | head -1)
if [[ -z "$want" ]]; then
  fail "cannot read CACHE_VERSION from public/sw.js"
elif [[ "$want" == "$have" ]]; then
  ok "ui cache version $have matches public/sw.js"
else
  fail "ui cache version is '${have:-none}', public/sw.js has '$want': rebuild the UI"
fi

if (( problems > 0 )); then
  echo "pack check: $problems problem(s)" >&2
  exit 1
fi
echo "pack check: all good"
