#!/usr/bin/env bash
# Self-test for scripts/design-lint.sh: runs it against throwaway trees and
# checks the exit code for each rule. Usage: scripts/design-lint.test.sh
set -euo pipefail

LINT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/design-lint.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0
n=0

# fixture <name>: fresh tree whose files use only Tonal names, including the
# ones that look like a retired name (text-primary is the primary role as
# text; a retired name inside a generated region of a stylesheet is skipped).
fixture() {
  local dir="$TMP/$1"
  mkdir -p "$dir/apps/desktop/src/lib" "$dir/apps/desktop/tests/e2e"
  cat > "$dir/apps/desktop/src/lib/Ok.svelte" <<'EOF'
<script>
	// Workaround for the overlay title bar (#317).
</script>
<p class="type-body-sm text-text bg-surface-container rounded-xl" style="color: var(--color-primary);">ok &#8212; fine</p>
<a class="type-label text-primary hover:bg-surface-container-high border-outline-strong">link</a>
<i class="text-text-muted text-text-subtle bg-surface-sunken bg-surface-overlay bg-primary-container text-success text-warning text-error bg-error-solid"></i>
EOF
  cat > "$dir/apps/desktop/src/lib/ok.ts" <<'EOF'
export const LINK = "focus-ring type-data-sm text-primary";
export const series = ["var(--color-data-1)", "var(--color-data-5)"];
// An accent of colour in prose is fine; so is a control height.
export const size = "var(--control-h)";
EOF
  cat > "$dir/apps/desktop/src/app.css" <<'EOF'
/* @generated:theme-start */
@theme {
  --color-text-primary: var(--cl-color-text);
  --radius-2xl: 28px;
}
/* @generated:theme-end */
body { color: var(--color-text-muted); }
EOF
  cat > "$dir/apps/desktop/tests/e2e/ok.spec.ts" <<'EOF'
const probe = "bg-surface-window text-text";
EOF
  echo "$dir"
}

expect() { # expect <exit-code> <label> <dir>
  local want=$1 label=$2 dir=$3 got=0
  n=$((n + 1))
  "$LINT" "$dir" > "$dir/out.txt" 2>&1 || got=$?
  if [[ "$got" == "$want" ]]; then
    echo "ok   $label"
  else
    echo "FAIL $label (exit $got, want $want)"; sed 's/^/     /' "$dir/out.txt"
    failures=$((failures + 1))
  fi
}

# with <file> <line>: a fresh fixture with one line appended to one file.
with() {
  local d
  d=$(fixture "case$n")
  printf '%s\n' "$2" >> "$d/apps/desktop/$1"
  echo "$d"
}

d=$(fixture clean)
expect 0 "clean tree passes (issue refs, entities, Tonal look-alikes, generated regions)" "$d"

expect 1 "desktop text-[Npx] fails" "$(with src/lib/Ok.svelte '<p class="text-[11px]">x</p>')"
expect 1 "desktop raw #hex fails" "$(with src/lib/Ok.svelte '<p style="color: #abcdef">x</p>')"
expect 1 "desktop 3-digit #hex fails" "$(with src/lib/Ok.svelte '<p style="color:#fff">x</p>')"

# Every retired name (spec §4.5), as a utility class in a component.
for cls in \
  bg-surface-panel bg-surface-surface bg-surface-raised hover:bg-surface-row-hover \
  border-border-default border-border-strong divide-border-faint \
  text-text-primary text-text-secondary text-text-tertiary text-text-disabled \
  text-text-data-bright text-text-log \
  bg-accent text-accent/80 text-accent-alt-violet bg-accent-alt-teal \
  text-status-ok text-status-warn text-status-err bg-status-err-solid text-status-info \
  bg-cluster-amber text-cluster-pink bg-cluster-blue text-cluster-magenta \
  bg-cluster-teal text-cluster-violet bg-cluster-indigo \
  type-caption type-colhead type-section type-subtitle \
  rounded-2xl rounded-t-2xl; do
  expect 1 "retired class $cls fails" "$(with src/lib/Ok.svelte "<p class=\"$cls\">x</p>")"
done

# The same names as CSS variables, in TypeScript, CSS and an e2e spec.
expect 1 "retired variable in TypeScript fails" "$(with src/lib/ok.ts 'const c = "var(--color-status-warn)";')"
expect 1 "cluster colour in TypeScript fails" "$(with src/lib/ok.ts 'const c = "var(--cl-color-cluster-teal)";')"
expect 1 "--alpha-* recipe fails" "$(with src/lib/Ok.svelte '<p style="background: var(--alpha-selection-bg)">x</p>')"
expect 1 "retired variable in hand-written CSS fails" "$(with src/app.css 'a { color: var(--color-border-strong); }')"
expect 1 "radius 2xl in hand-written CSS fails" "$(with src/app.css 'a { border-radius: var(--radius-2xl); }')"
expect 1 "retired class in an e2e spec fails" "$(with tests/e2e/ok.spec.ts 'el.className = "text-text-primary";')"

d=$(with src/lib/Ok.svelte '<p class="type-caption">x</p>')
expect 1 "the failure points at design/README.md" "$d"
n=$((n + 1))
if ! grep -q 'design/README.md' "$d/out.txt"; then
  echo "FAIL the failure message names design/README.md"; failures=$((failures + 1))
fi

if (( failures )); then echo "design-lint self-test: $failures failure(s) in $n checks"; exit 1; fi
echo "design-lint self-test: all $n checks passed"
