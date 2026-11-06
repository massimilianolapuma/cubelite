#!/usr/bin/env bash
# Self-test for scripts/design-lint.sh: runs it against throwaway trees and
# checks the exit code for each rule. Usage: scripts/design-lint.test.sh
set -euo pipefail

LINT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/design-lint.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0

# fixture <name>: fresh tree with one clean Svelte component.
fixture() {
  local dir="$TMP/$1"
  mkdir -p "$dir/apps/desktop/src/lib"
  cat > "$dir/apps/desktop/src/lib/Ok.svelte" <<'EOF'
<script>
	// Workaround for the overlay title bar (#317).
</script>
<p class="type-body text-text-primary" style="color: var(--color-accent);">ok &#8212; fine</p>
EOF
  echo "$dir"
}

expect() { # expect <exit-code> <label> <dir>
  local want=$1 label=$2 dir=$3 got=0
  "$LINT" "$dir" > "$dir/out.txt" 2>&1 || got=$?
  if [[ "$got" == "$want" ]]; then
    echo "ok   $label"
  else
    echo "FAIL $label (exit $got, want $want)"; sed 's/^/     /' "$dir/out.txt"
    failures=$((failures + 1))
  fi
}

d=$(fixture clean);  expect 0 "clean tree passes (issue refs and entities ignored)" "$d"

d=$(fixture px);     echo '<p class="text-[11px]">x</p>' >> "$d/apps/desktop/src/lib/Ok.svelte"
expect 1 "desktop text-[Npx] fails" "$d"

d=$(fixture hex);    echo '<p style="color: #abcdef">x</p>' >> "$d/apps/desktop/src/lib/Ok.svelte"
expect 1 "desktop raw #hex fails" "$d"

d=$(fixture hex3);   echo '<p style="color:#fff">x</p>' >> "$d/apps/desktop/src/lib/Ok.svelte"
expect 1 "desktop 3-digit #hex fails" "$d"

if (( failures )); then echo "design-lint self-test: $failures failure(s)"; exit 1; fi
echo "design-lint self-test: all passed"
