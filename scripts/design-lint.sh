#!/usr/bin/env bash
# design-lint: keep both apps on the design system (spec §5, #360).
#
#   desktop  apps/desktop/src/**/*.svelte  → no `text-[Npx]` classes and no raw
#            `#hex` colours (use the type-* utilities and colour tokens).
#   native   apps/macos/**/Views/**/*.swift → no `.font(.system…)` / text-style
#            fonts and no raw system colours (use DesignTokens.Typography and
#            DesignTokens colours).
#
# Desktop is held at zero. Native residue is capped per file by
# scripts/design-lint-allow.txt ("<path> <max>"); exceeding a cap fails, and a
# file below its cap prints a hint to tighten the allow-list.
#
# Usage: scripts/design-lint.sh [repo-root]   (defaults to the script's repo)
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ALLOW="${DESIGN_LINT_ALLOW:-$ROOT/scripts/design-lint-allow.txt}"
cd "$ROOT"

DESKTOP_PX='text-\[[0-9.]+px\]'
# 3/4/6/8-digit hex colours not preceded by `&` (HTML entities) or a word char.
DESKTOP_HEX='(^|[^&[:alnum:]_])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b'
NATIVE_FONT='\.font\(\.(system|largeTitle|title[23]?|headline|subheadline|body|callout|footnote|caption2?)\b'
NATIVE_COLOR='(Color\.|[(:,[:space:]]\.)(blue|green|orange|red|purple|indigo|teal|yellow)\b'

fail=0

# Prints "<count>" of matching lines for an extended regex in one file.
count() { grep -cE "$1" "$2" || true; }

# Raw hex matches, minus ones made only of decimal digits (issue refs like #317).
count_hex() {
  { grep -oE "$DESKTOP_HEX" "$1" || true; } | sed -E 's/^[^#]*#//' | grep -cvE '^[0-9]+$' || true
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

declare -A cap=()
if [[ -f "$ALLOW" ]]; then
  while read -r path max _; do
    [[ -z "${path:-}" || "$path" == \#* ]] && continue
    cap["$path"]=$max
  done < "$ALLOW"
fi

echo "design-lint: native (capped by ${ALLOW#"$ROOT"/})"
native_total=0
declare -A seen=()
while IFS= read -r -d '' f; do
  n=$(( $(count "$NATIVE_FONT" "$f") + $(count "$NATIVE_COLOR" "$f") ))
  max=${cap["$f"]:-0}
  seen["$f"]=1
  native_total=$(( native_total + n ))
  if (( n > max )); then
    echo "  FAIL $f: $n (allowed $max)"
    grep -nE "$NATIVE_FONT|$NATIVE_COLOR" "$f" | sed 's/^/       /'
    fail=1
  elif (( n > 0 )); then
    echo "  ok   $f: $n (allowed $max)"
  fi
  if (( n < max )); then
    echo "  hint $f: $n < allowed $max — lower its entry in the allow-list"
  fi
done < <(find apps/macos -path '*/Views/*' -name '*.swift' -print0 2>/dev/null | sort -z)
for path in "${!cap[@]}"; do
  [[ -n "${seen[$path]:-}" ]] || echo "  hint $path: listed in the allow-list but not found — remove the entry"
done
echo "  total: $native_total"

if (( fail )); then
  echo "design-lint: FAILED — use design tokens (see docs/design-audit-2026-09.md)"
  exit 1
fi
echo "design-lint: OK"
