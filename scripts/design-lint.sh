#!/usr/bin/env bash
# design-lint: keep the desktop app on the design system (spec §5, #360).
#
#   apps/desktop/src/**/*.svelte → no `text-[Npx]` classes and no raw `#hex`
#   colours (use the type-* utilities and colour tokens). Held at zero.
#
# Usage: scripts/design-lint.sh [repo-root]   (defaults to the script's repo)
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

DESKTOP_PX='text-\[[0-9.]+px\]'
# 3/4/6/8-digit hex colours not preceded by `&` (HTML entities) or a word char.
DESKTOP_HEX='(^|[^&[:alnum:]_])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b'

fail=0

# Prints "<count>" of matching lines for an extended regex in one file.
count() {
  local pattern=$1 file=$2
  grep -cE "$pattern" "$file" || true
}

# Raw hex matches, minus ones made only of decimal digits (issue refs like #317).
count_hex() {
  local file=$1
  { grep -oE "$DESKTOP_HEX" "$file" || true; } | sed -E 's/^[^#]*#//' | grep -cvE '^[0-9]+$' || true
}

echo "design-lint: desktop (limit 0)"
desktop_total=0
while IFS= read -r -d '' f; do
  n=$(( $(count "$DESKTOP_PX" "$f") + $(count_hex "$f") ))
  if (( n > 0 )); then
    echo "  FAIL $f: $n"
    grep -nE "$DESKTOP_PX|$DESKTOP_HEX" "$f" | sed 's/^/       /'
    desktop_total=$(( desktop_total + n ))
    fail=1
  fi
done < <(find apps/desktop/src -name '*.svelte' -print0 2>/dev/null | sort -z)
echo "  total: $desktop_total"

if (( fail )); then
  echo "design-lint: FAILED — use design tokens (see docs/design-audit-2026-09.md)"
  exit 1
fi
echo "design-lint: OK"
