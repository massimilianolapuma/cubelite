#!/usr/bin/env bash
# gates: every local quality gate of the desktop app in one command.
#
# Prints one line per gate (ok / FAIL / skip, what it counted, how long it
# took) and, for a failing gate, the end of its output. The full output of
# each gate is kept in a log file whose path is printed at the end. Exits
# non-zero when any gate failed.
#
# Usage: scripts/gates.sh [--no-e2e] [--rust] [--only a,b,c] [repo-root]
#   gates: lint types unit design lint-test design-lint e2e
#          (and, with --rust: rust)
#   --no-e2e   skip the Playwright suite (the slowest gate)
#   --rust     also run cargo fmt --check, clippy and the workspace tests
#   --only     run just the named gates, comma-separated
set -uo pipefail

ROOT=""
ONLY=""
E2E=1
RUST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-e2e) E2E=0 ;;
    --rust) RUST=1 ;;
    --only) ONLY="$2"; shift ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ROOT="$1" ;;
  esac
  shift
done
ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || exit 2
# A gate that passes because nothing ran is worse than no gate: pnpm exits 0
# when its filter matches no project.
if [ ! -f apps/desktop/package.json ]; then
  echo "gates: $ROOT is not the CubeLite repository (no apps/desktop/package.json)" >&2
  exit 2
fi

TMP="${TMPDIR:-/tmp}"
LOGS="${TMP%/}/cubelite-gates"
mkdir -p "$LOGS"
failed=0

wanted() {
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; esac
  return 1
}

# run <gate> <summary-command> <command...>: runs the command with its output
# in the gate's log; the summary command reads that log and prints the counts.
run() {
  local gate="$1" summary="$2"
  shift 2
  wanted "$gate" || return 0
  local log="$LOGS/$gate.log" start=$SECONDS status
  "$@" >"$log" 2>&1
  status=$?
  local took=$((SECONDS - start)) counted
  counted="$(eval "$summary" <"$log" 2>/dev/null | tr -s ' ' | head -1)"
  if [ "$status" -eq 0 ]; then
    printf 'ok    %-12s %s (%ss)\n' "$gate" "${counted:-passed}" "$took"
  else
    failed=1
    printf 'FAIL  %-12s %s (%ss)\n' "$gate" "${counted:-exit $status}" "$took"
    tail -n 40 "$log" | sed 's/^/      | /'
  fi
}

skip() {
  wanted "$1" && printf 'skip  %-12s %s\n' "$1" "$2"
}

# design-lint.sh and its self-test need bash 4; macOS ships 3.2.
BASH4="bash"
[ -x /opt/homebrew/bin/bash ] && BASH4=/opt/homebrew/bin/bash

run lint 'true' pnpm -s --filter desktop lint
run types 'grep -Eo "[0-9]+ ERRORS [0-9]+ WARNINGS" | tail -1' \
  sh -c 'cd apps/desktop && npx svelte-check --threshold error'
run unit 'grep -E "^ +Tests " | tail -1' pnpm -s --filter desktop test
if grep -q '"design:test"' package.json 2>/dev/null; then
  run design 'grep -E "^ℹ (pass|fail) " | tr "\n" " "' pnpm -s design:test
else
  skip design 'no design:test script on this branch'
fi
run lint-test 'grep -E "self-test:"' "$BASH4" scripts/design-lint.test.sh
run design-lint 'grep -E "total:|design-lint:" | tr "\n" " "' "$BASH4" scripts/design-lint.sh
if [ "$E2E" -eq 1 ]; then
  run e2e 'grep -E "^ +[0-9]+ (passed|failed|flaky)" | tr "\n" " "' \
    sh -c 'cd apps/desktop && npx playwright test --workers 1'
else
  skip e2e '--no-e2e'
fi
if [ "$RUST" -eq 1 ]; then
  run rust 'grep -E "^test result:" | tail -1' \
    sh -c 'cargo fmt --check && cargo clippy --workspace -- --deny warnings && cargo test --workspace'
fi

echo "logs: $LOGS"
exit "$failed"
