#!/usr/bin/env bash
# design-lint: keep the desktop app on the Tonal design system (design/README.md).
#
#   apps/desktop/src/**/*.svelte  → no `text-[Npx]` classes and no raw `#hex`
#                                   colours (use the type-* utilities and the
#                                   colour roles).
#   apps/desktop/{src,tests}/**/*.{svelte,ts,js,css}
#                                 → no name the Tonal restyle retired (spec
#                                   §4.5): the v2 colour names, the v2 type
#                                   styles, the --alpha-* recipes, radius 2xl,
#                                   and the tokens dropped with them
#                                   (shadow-drawer, --control-height,
#                                   --row-pad-*, --icon-*, --min-hit-target).
#                                   The generated regions of app.css are
#                                   skipped: design:test keeps them in sync
#                                   with design/tokens.json.
#   Both held at zero.
#
# Usage: scripts/design-lint.sh [repo-root]   (defaults to the script's repo)
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

DESKTOP_PX='text-\[[0-9.]+px\]'
# 3/4/6/8-digit hex colours not preceded by `&` (HTML entities) or a word char.
DESKTOP_HEX='(^|[^&[:alnum:]_])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b'

# Retired names, one rule each: "<label>|<extended regex>". A colour name is
# matched only right after a colour utility (`bg-`, `text-`, `border-t-`, …)
# or a colour variable (`--color-`, `--cl-color-`), itself not part of a longer
# word: `text-primary` (the primary role as text) stays allowed while
# `text-text-primary` (the v2 primary text) does not, and an attribute or a word
# that merely ends in a retired stem (`data-accent`, `conn-status-ok`,
# "pre-accent") is not a colour at all.
END='([^[:alnum:]_-]|$)'
COLOR_UTIL='(^|[^[:alnum:]_-])(--color|--cl-color|bg|text|fill|stroke|border(-[xytrblse])?|outline|ring|inset-ring|ring-offset|divide|placeholder|caret|accent|decoration|shadow|inset-shadow|from|via|to)'
RETIRED=(
  "v2 surface (surface-container, surface-container-high)|$COLOR_UTIL-surface-(panel|surface|raised|row-hover)$END"
  "v2 border (outline, outline-strong)|$COLOR_UTIL-border-(default|strong|faint)$END"
  "v2 text colour (text, text-muted, text-subtle)|$COLOR_UTIL-text-(primary|secondary|tertiary|disabled|data-bright|log)$END"
  "accent (primary, data-*)|$COLOR_UTIL-accent(-alt-(violet|teal))?$END"
  "status-* (success, warning, error, error-solid)|$COLOR_UTIL-status-(ok|warn|err|err-solid|info)$END"
  "cluster-* colour (a data-tint subtree, data-*)|$COLOR_UTIL-cluster-(amber|pink|blue|magenta|teal|violet|indigo)$END"
  "v2 type style (title, body-sm, label)|(^|[^[:alnum:]_-])type-(caption|colhead|section|subtitle)$END"
  "--alpha-* recipe (a container role)|--alpha-[[:alnum:]-]+"
  "radius 2xl (xl)|(rounded(-[a-z]{1,2})?|--radius)-2xl$END"
  "removed shadow (shadow-overlay, under overlays only)|(^|[^[:alnum:]_-])(--(cl-)?)?shadow-drawer$END"
  "removed size token (--control-h, --row-h, an h-/w- size)|(^|[^[:alnum:]_-])--(control-height|row-pad-(default|compact)|icon-(2xs|xs|sm|md|lg|xl|2xl)|min-hit-target)$END"
)

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

# A file's text with the generated regions of a stylesheet blanked out (line
# numbers kept).
source_text() {
  local file=$1
  if [[ "$file" == *.css ]]; then
    awk '/@generated:[a-z]+-start/ { skip = 1 } { print (skip ? "" : $0) } /@generated:[a-z]+-end/ { skip = 0 }' "$file"
  else
    cat "$file"
  fi
}

echo "design-lint: desktop px and hex (limit 0)"
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

echo "design-lint: retired names (limit 0)"
retired_total=0
any=""
for rule in "${RETIRED[@]}"; do any="${any:+$any|}(${rule#*|})"; done
# One grep over every file finds the few that need a closer look.
while IFS= read -r -d '' f; do
  text=$(source_text "$f")
  for rule in "${RETIRED[@]}"; do
    label=${rule%%|*}
    pattern=${rule#*|}
    hits=$(grep -nE -- "$pattern" <<<"$text" || true)
    [[ -z "$hits" ]] && continue
    n=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
    echo "  FAIL $f: $n × $label"
    printf '%s\n' "$hits" | sed 's/^/       /'
    retired_total=$(( retired_total + n ))
    fail=1
  done
done < <(find apps/desktop/src apps/desktop/tests -type f \
  \( -name '*.svelte' -o -name '*.ts' -o -name '*.js' -o -name '*.css' \) -print0 2>/dev/null \
  | xargs -0 grep -lE --null -- "$any" 2>/dev/null | sort -z)
echo "  total: $retired_total"

if (( fail )); then
  echo "design-lint: FAILED — use the Tonal tokens (see design/README.md)"
  exit 1
fi
echo "design-lint: OK"
