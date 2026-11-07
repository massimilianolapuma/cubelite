#!/usr/bin/env bash
# Self-test for install.sh: the mirror rewrite (including the mirror list that
# Ubuntu 26.04 runners resolve the archive through, #569) and the .deb cache,
# with apt-get/dpkg stubbed. Usage: .github/actions/tauri-linux-deps/install.test.sh
set -euo pipefail

INSTALL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0

fails() { ! "$@"; }

check() { # check <description> <command...>
  local what="$1"
  shift
  if "$@"; then
    echo "ok   $what"
  else
    echo "FAIL $what"
    failures=$((failures + 1))
  fi
}

# --- mirror rewrite ---------------------------------------------------------
mkdir -p "$TMP/apt"
printf 'https://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://security.ubuntu.com/ubuntu/\tpriority:2\n' \
  > "$TMP/apt/apt-mirrors.txt"
printf 'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: resolute\n' > "$TMP/apt/ubuntu.sources"
ONLY=switch-mirror SUDO="" FALLBACK_MIRROR="https://fallback.example/ubuntu/" \
  SOURCES_FILES="$TMP/apt/apt-mirrors.txt $TMP/apt/ubuntu.sources $TMP/apt/missing.list" \
  "$INSTALL" > "$TMP/switch.log"
check "mirror list points at the fallback" \
  grep -q $'^https://fallback.example/ubuntu/\tpriority:1$' "$TMP/apt/apt-mirrors.txt"
check "security mirror is left alone" grep -q '^https://security.ubuntu.com/ubuntu/' "$TMP/apt/apt-mirrors.txt"
check "mirror+file source is left alone" grep -q 'mirror+file:/etc/apt/apt-mirrors.txt' "$TMP/apt/ubuntu.sources"
check "a missing file is skipped" fails grep -q missing.list "$TMP/switch.log"

# --- .deb cache -------------------------------------------------------------
# Stubs: `apt-get install` "downloads" new.deb unless APT_FAIL is set.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == update ]] && exit 0
[[ -n "${APT_FAIL:-}" ]] && exit 100
touch "$ARCHIVES_DIR/new.deb"
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/dpkg"
chmod +x "$TMP/bin/apt-get" "$TMP/bin/dpkg"

run_install() { # run_install <archives> <cache> [extra env...]
  local archives="$1" cache="$2"
  shift 2
  env PATH="$TMP/bin:$PATH" SUDO="" ATTEMPTS=1 SOURCES_FILES="" \
    ARCHIVES_DIR="$archives" DEB_CACHE="$cache" "$@" "$INSTALL" > "$TMP/install.log" 2>&1
}

mkdir -p "$TMP/archives" "$TMP/cache"
touch "$TMP/cache/old.deb" "$TMP/archives/lock"
check "install succeeds with a warm cache" run_install "$TMP/archives" "$TMP/cache"
check "cached .deb seeded into the archive cache" test -f "$TMP/archives/old.deb"
check "downloaded .deb kept for the next run" test -f "$TMP/cache/new.deb"
check "only .deb files are cached" test ! -e "$TMP/cache/lock"

mkdir -p "$TMP/archives2"
check "install succeeds with no cache directory yet" run_install "$TMP/archives2" "$TMP/fresh-cache"
check "first run fills the cache" test -f "$TMP/fresh-cache/new.deb"

mkdir -p "$TMP/archives3" "$TMP/cache3"
touch "$TMP/cache3/keep.deb"
check "failed install exits non-zero" fails run_install "$TMP/archives3" "$TMP/cache3" APT_FAIL=1
check "failed install leaves the cache as it was" test -f "$TMP/cache3/keep.deb"
check "failed install does not save a partial cache" test ! -e "$TMP/cache3/new.deb"

mkdir -p "$TMP/archives4"
check "no DEB_CACHE means no cache" run_install "$TMP/archives4" ""
check "no DEB_CACHE logs nothing about the cache" fails grep -qi 'deb file' "$TMP/install.log"

if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
