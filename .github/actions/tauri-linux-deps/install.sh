#!/usr/bin/env bash
# Installs the system packages the Tauri / WebKit crates need on Ubuntu
# runners. Every apt step runs under a timeout and is retried, and after the
# first failure the Ubuntu mirror is switched to the fallback, so a slow or
# broken mirror costs minutes instead of the whole job (#435).
#
# Environment (all optional, mainly for tests):
#   INSTALL_RECOMMENDS  "true" to keep apt's Recommends (release bundles);
#                       default "false" (clippy/tests only need the -dev packages)
#   ATTEMPTS            number of attempts (default 3)
#   UPDATE_TIMEOUT      timeout for each `apt-get update` (default 2m)
#   INSTALL_TIMEOUT     timeout for each `apt-get install` (default 5m)
#   FALLBACK_MIRROR     mirror used from the second attempt on
#   SOURCES_FILES       apt source files to rewrite (space separated)
#   SUDO                command prefix for apt/dpkg (default sudo; "" in tests)
set -euo pipefail

PACKAGES=(
  libgtk-3-dev
  libwebkit2gtk-4.1-dev
  libjavascriptcoregtk-4.1-dev
  libsoup-3.0-dev
  libayatana-appindicator3-dev
)

INSTALL_RECOMMENDS="${INSTALL_RECOMMENDS:-false}"
ATTEMPTS="${ATTEMPTS:-3}"
UPDATE_TIMEOUT="${UPDATE_TIMEOUT:-2m}"
INSTALL_TIMEOUT="${INSTALL_TIMEOUT:-5m}"
FALLBACK_MIRROR="${FALLBACK_MIRROR:-http://archive.ubuntu.com/ubuntu/}"
SOURCES_FILES="${SOURCES_FILES:-/etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list}"
SUDO="${SUDO-sudo}"
# As an array so an empty SUDO (tests) disappears instead of becoming "".
sudo_cmd=()
if [[ -n "$SUDO" ]]; then
  sudo_cmd=("$SUDO")
fi

# Acquire::Retries covers transient per-file errors; the outer loop covers a
# mirror that is up but too slow to finish within the timeout.
apt_common=(-y -q -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Dpkg::Use-Pty=0)
install_opts=("${apt_common[@]}")
if [[ "$INSTALL_RECOMMENDS" != "true" ]]; then
  install_opts+=(--no-install-recommends)
fi

switch_mirror() {
  local f
  for f in $SOURCES_FILES; do
    [[ -f "$f" ]] || continue
    # Hosted runners point at a regional mirror such as
    # http://azure.archive.ubuntu.com/ubuntu/; archive.ubuntu.com is separate
    # infrastructure. security.ubuntu.com is left alone.
    local tmp
    tmp="$(mktemp)"
    sed -E "s#https?://[A-Za-z0-9.-]*archive\.ubuntu\.com/ubuntu/?#${FALLBACK_MIRROR}#g" "$f" > "$tmp"
    "${sudo_cmd[@]}" cp "$tmp" "$f" # cp keeps the file's owner and mode
    rm -f "$tmp"
    echo "Rewrote $f to use $FALLBACK_MIRROR"
  done
}

run_attempt() {
  timeout "$UPDATE_TIMEOUT" "${sudo_cmd[@]}" apt-get update "${apt_common[@]}" \
    && timeout "$INSTALL_TIMEOUT" "${sudo_cmd[@]}" apt-get install "${install_opts[@]}" "${PACKAGES[@]}"
}

for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
  if run_attempt; then
    echo "Tauri Linux dependencies installed (attempt $attempt/$ATTEMPTS)"
    exit 0
  fi
  echo "::warning::apt-get attempt $attempt/$ATTEMPTS failed or timed out"
  # A kill during dpkg leaves half-configured packages behind; clean up so the
  # next attempt does not fail on "dpkg was interrupted".
  "${sudo_cmd[@]}" dpkg --configure -a || true
  if (( attempt == 1 )); then
    switch_mirror
  fi
  if (( attempt < ATTEMPTS )); then
    sleep $((attempt * 10))
  fi
done

echo "::error::apt-get failed after $ATTEMPTS attempts; see the warnings above"
exit 1
