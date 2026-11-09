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
         ui/index.html ui/sw.js ui/m/index.html ui/m/sw.js ui/m/manifest.webmanifest \
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

# 2b. The packed UI must not be older than the source it was built from. A failed
#     or skipped UI build leaves the previous ui/ in place and the pack looks fine.
if [[ -f "$DIST/ui/index.html" ]]; then
  stale_ui=$(find "$ROOT/src" "$ROOT/public" -type f -newer "$DIST/ui/index.html" -print -quit 2>/dev/null)
  [[ -z "$stale_ui" ]] && ok "ui is newer than every file in src/ and public/" || fail "ui is older than ${stale_ui#$ROOT/}: rebuild the UI"
fi

# 3. The packed pages are the pages in public/: same service-worker cache
#    versions, for the desktop app (ui/sw.js) and the mobile app (ui/m/sw.js).
for sw in sw.js m/sw.js; do
  want=$(sed -n 's/^const CACHE_VERSION = "\(.*\)";.*/\1/p' "$ROOT/public/$sw" | head -1)
  have=$(sed -n 's/^const CACHE_VERSION = "\(.*\)";.*/\1/p' "$DIST/ui/$sw" 2>/dev/null | head -1)
  if [[ -z "$want" ]]; then
    fail "cannot read CACHE_VERSION from public/$sw"
  elif [[ "$want" == "$have" ]]; then
    ok "ui/$sw cache version $have matches public/$sw"
  else
    fail "ui/$sw cache version is '${have:-none}', public/$sw has '$want': rebuild the UI"
  fi
done

if (( problems > 0 )); then
  echo "pack check: $problems problem(s)" >&2
  exit 1
fi
echo "pack check: all good"
