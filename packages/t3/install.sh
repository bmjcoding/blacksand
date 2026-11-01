#!/usr/bin/env bash
# Blacksand T3 installer for macOS and Linux. Safe to rerun: every step checks
# before acting.
#
#   ./install.sh [--role ui|host|both] [--unisolated-build]   # hourly update check (macOS: vault "Personal")
#   BLACKSAND_T3_UPDATE_DAY=daily BLACKSAND_T3_UPDATE_HOUR=6 BLACKSAND_T3_VAULT=Other ./install.sh
#
# Run it as yourself, not with sudo: it asks for sudo for the steps that need it.
#
# Roles (packages/t3/docs/getting-started/roles.md):
#   ui    (default) the desktop app you work in.
#   host  macOS only. Agents run here in their own accounts, reached over SSH;
#         the app is installed for them in /Applications and not opened, and the
#         update check runs as a LaunchDaemon (as you), so it keeps running with
#         nobody logged in. Then add each account, e.g.:
#         sudo scripts/add-agent-account.sh agent-claude --key ~/.ssh/blacksand.pub
#   both  macOS only. The desktop app plus an agent account on this machine (a
#         standby lane), e.g.:
#         sudo scripts/add-agent-account.sh agent-standby --loopback-only --key ~/.ssh/blacksand.pub
#
# macOS: installs missing tools with Homebrew, sets up the shared signing
#   identity from 1Password (from your Apple Development certificate on the
#   first Mac), builds, installs.
# Linux (Omarchy/Arch, Ubuntu/Debian, Fedora/RHEL): installs system packages
#   with the distro package manager and Node 24 into your home directory, then
#   builds and installs. No signing step: Linux keyrings don't tie access to an
#   app's signature.
# Both: creates a separate, unprivileged build account (_blacksand-build) so the
#   scheduled build's dependency and build scripts can't read your home (which
#   it makes private if they could); on macOS its own home is closed to every
#   account but it and yours. pnpm and, on Linux, rustup are pinned
#   versions checked against the digests below. Needs sudo once; without it the
#   install stops before any upstream code runs.
#   --unisolated-build: where the build account can't be set up (no sudo),
#   build as you instead. Upstream's dependency and build scripts then run with
#   your files and credentials; every later update does too (bin/t3
#   status says so), until ./install.sh runs again with sudo.

set -euo pipefail
cd "$(dirname "$0")"
# lib/pnpm-cli.mjs (lib/pnpm.mjs's commands): the pinned pnpm, and the checks of root's build tools and their lock.
PNPM_CHECK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/pnpm-cli.mjs"

# Output and the legacy install refusal (shared with the setup scripts).
# shellcheck source=scripts/host-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/host-common.sh"
# Builds as root would run upstream's dependency and build scripts as root, and
# leave root-owned files your own runs can't update.
((EUID != 0)) || die "run ./install.sh as yourself, not as root or with sudo; it asks for sudo when it needs it"

ROLE=ui
UNISOLATED=0
while (($#)); do
  case "$1" in
    --role) ROLE="${2:-}"; shift 2 ;;
    --role=*) ROLE="${1#--role=}"; shift ;;
    --unisolated-build) UNISOLATED=1; shift ;;
    *) printf 'usage: ./install.sh [--role ui|host|both] [--unisolated-build]\n' >&2; exit 2 ;;
  esac
done
case "$ROLE" in ui | host | both) ;; *) printf 'unknown role: %s (ui, host or both)\n' "$ROLE" >&2; exit 2 ;; esac
# Agent accounts, the shared /Applications install and host updates are macOS's.
[[ "$ROLE" == ui || "$(uname -s)" == Darwin ]] || die "--role $ROLE is macOS only; on Linux, install with --role ui"

HOUR="${BLACKSAND_T3_UPDATE_HOUR:-4}"
# Hourly: with pin.json a run builds only when the pin moved (security fixes within the hour).
DAY="${BLACKSAND_T3_UPDATE_DAY:-hourly}"
VAULT="${BLACKSAND_T3_VAULT:-Personal}"
OP_ITEM="Blacksand T3 code signing"
NODE_MAJOR=24

have() { command -v "$1" >/dev/null 2>&1; }
# The oldest patched release on each line Node supports (Oct 2026 security release:
# Brotli RCE CVE-2026-111497 and TLS hostname bypasses). Raise when Node ships a new one.
NODE_PATCHED='{"22":"22.23.4","24":"24.22.1","26":"26.12.1"}'
NODE_CHECK='
  const [maj, min, pat] = process.versions.node.split(".").map(Number);
  const floor = JSON.parse(process.argv[1])[maj];
  const [fmaj, fmin, fpat] = (floor ?? "0.0.0").split(".").map(Number);
  const patched = floor ? (min > fmin || (min === fmin && pat >= fpat)) : maj > 26;
  process.exit(maj >= Number(process.argv[2]) && patched ? 0 : 1);
'
# Whether node ($1, default the one on PATH) is Node $NODE_MAJOR+ with the security floor.
# shellcheck disable=SC2120 # $1 is for tests; the script itself checks the node on PATH
node_ok() {
  local node="${1:-node}"
  have "$node" && "$node" -e "$NODE_CHECK" "$NODE_PATCHED" "$NODE_MAJOR"
}

# git's floor, the same as lib/git.mjs checks before every git it runs: every fix
# git's advisories (https://github.com/git/git/security/advisories) list, the last
# CVE-2024-52005 (a server's terminal control codes passed through as "remote:"
# output), filtered only from 2.55.0, on no older line. Raise it when git ships a
# new fix. The version is all that's checked: Apple's git ("2.54.0 (Apple
# Git-157)") counts as its upstream release (Apple's notes name fixed CVEs, not
# backports, and Git-157 passes those control codes through), so macOS takes
# Homebrew's. A distro that backports fixes without changing the number is
# refused, never an unpatched git accepted.
GIT_MIN=2.55.0

# A version (2.47.3) as one number to compare.
version_key() {
  local maj min pat
  IFS=. read -r maj min pat <<<"$1"
  echo $((10#$maj * 1000000 + 10#$min * 1000 + 10#${pat:-0}))
}

# Why the git that `$@ --version` runs (default: git on PATH) can't be used;
# nothing, and status 0, when it can.
git_problem() {
  local cmd=("$@") out version re='^git version ([0-9]+)\.([0-9]+)(\.([0-9]+))?'
  ((${#cmd[@]})) || cmd=(git)
  out="$("${cmd[@]}" --version 2>/dev/null)" || { echo "no git found"; return 1; }
  [[ "$out" =~ $re ]] || { echo "can't read git's version (${out:-nothing})"; return 1; }
  version="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[4]:-0}"
  if (($(version_key "$version") < $(version_key "$GIT_MIN"))); then
    echo "git $version is too old: Blacksand T3 needs $GIT_MIN or later, for security fixes (CVE-2024-52005)"
    return 1
  fi
}
git_ok() { git_problem >/dev/null; }

# rustup-init (Linux; macOS takes Rust from Homebrew) and the toolchain it installs:
# outside any package manager's age gate, so pinned and checked against these
# digests (raise them deliberately, and only to releases at least 3 days old).
# pnpm's pin is lib/pnpm.mjs's, which every build checks too.
RUSTUP_VERSION=1.29.2
RUST_TOOLCHAIN=1.99.1
rustup_sha256() {
  case "$1" in
    x86_64-unknown-linux-gnu) echo 5be191e8c70a5007074254cb74d78dbfdd25cd5a61c27de7b8e5410122ec24f4 ;;
    aarch64-unknown-linux-gnu) echo a9c168dbea81a84671c6b7a5c1795cb0eb699020110d107ddfca427bd797e697 ;;
    *) die "no pinned rustup for $1" ;;
  esac
}

# Downloads $1 to $3 and checks its SHA-$4 (256 or 512) is $2.
fetch_pinned() {
  local url="$1" want="$2" out="$3" bits="$4" got
  curl --proto '=https' --tlsv1.2 -fsSL -o "$out" "$url"
  if have "sha${bits}sum"; then got="$("sha${bits}sum" "$out")"; else got="$(shasum -a "$bits" "$out")"; fi
  [[ "${got%% *}" == "$want" ]] || die "$url doesn't match its pinned SHA-$bits digest"
}

# The pinned pnpm (lib/pnpm.mjs fetch: its registry tarballs checked against their
# pinned digests, no install script run) in $1/pnpm, laid out as npm -g would under
# a prefix, and a Vite+ home holding the same binary in $1/vite-plus.
pnpm_fetch() { node "$PNPM_CHECK" fetch "$1"; }

# Whether the pnpm under prefix $1 is the pinned binary (lib/pnpm.mjs's check: its
# sha-256, a regular file). Its version string alone could be any file's.
pnpm_installed() { node "$PNPM_CHECK" check-pnpm "$1/lib/node_modules/pnpm/pnpm" 2>/dev/null; }

# Installs the pinned pnpm under your own prefix $1 (bin/ and lib/node_modules/, as
# npm -g would), over whatever is there.
install_pnpm() {
  local prefix="$1" tmp bin
  say "Installing the pinned pnpm into $prefix"
  tmp="$(mktemp -d)"
  pnpm_fetch "$tmp" || die "couldn't get the pinned pnpm"
  mkdir -p "$prefix/lib/node_modules" "$prefix/bin"
  rm -rf "$prefix/lib/node_modules/pnpm"
  cp -R "$tmp/pnpm/lib/node_modules/pnpm" "$prefix/lib/node_modules/pnpm"
  for bin in pnpm pn pnpx pnx; do ln -sfn "../lib/node_modules/pnpm/$bin" "$prefix/bin/$bin"; done
  rm -rf "$tmp"
  pnpm_installed "$prefix" || die "the pnpm installed into $prefix isn't the pinned binary"
}

# The pnpm builds run as the build account, and the Vite+ home (VP_HOME) upstream's
# build runs pnpm from, both root's and only root's to change: the build account
# runs upstream's install scripts and build, which could otherwise replace the
# binary between lib/pnpm.mjs's checks and its use. The Vite+ home holds the same
# binary where Vite+ keeps a pnpm it downloaded, with launchers that run nothing
# from PATH (lib/pnpm.mjs BUILD_TOOLS_ROOT, seedVitePlusHome). On macOS they
# live outside /usr/local, which an Intel Mac's Homebrew owns; every directory up
# to / must be root's, which the check below confirms here, not at a build.
case "$(uname -s)" in
  Darwin) BUILD_TOOLS="/Library/Application Support/blacksand/tools" ;;
  *) BUILD_TOOLS=/usr/local/libexec/blacksand/tools ;;
esac

# Why the build tools in $1 aren't fit for the build account (printed; status 1),
# or nothing: lib/pnpm.mjs's own check (root's all the way up, no ACL grants, the
# pinned bytes, the Vite+ home exactly), then what the build account itself can
# do with them: open and run all of it, and change none of it or what's above.
build_tools_problem() {
  local dir="$1" p entries=() above=()
  node "$PNPM_CHECK" check-build-tools "$dir" || return 1
  p="$dir/pnpm/lib/node_modules/pnpm/pnpm"
  as_builder "$p" --version >/dev/null 2>&1 || { echo "$BUILDER can't run $p"; return 1; }
  while IFS= read -r -d '' p; do entries+=("$p"); done < <(find "$dir" -print0)
  p="$dir"
  while [[ "$p" != / ]]; do p="$(dirname "$p")"; above+=("$p"); done
  # shellcheck disable=SC2016 # expanded by the inner sh
  p="$(as_builder /bin/sh -c 'for p do if [ -d "$p" ]; then [ -x "$p" ] || echo "$p"; else [ -r "$p" ] || echo "$p"; fi; done' sh "${entries[@]}")"
  [[ -z "$p" ]] || { echo "$BUILDER can't open: $p"; return 1; }
  # shellcheck disable=SC2016
  p="$(as_builder /bin/sh -c 'for p do [ -w "$p" ] && echo "$p"; done; true' sh "${entries[@]}" "${above[@]}")"
  [[ -z "$p" ]] || { echo "$BUILDER can change: $p"; return 1; }
}

# The tools' lock, $BUILD_TOOLS.lock (lib/pnpm.mjs buildToolsLock, toolsLockPolicy):
# an install holds it exclusive, a build shared. Anyone who can open a file can
# flock it, and so hold the others off, so only root, admins (you) and the build
# account can open this one: on macOS root:admin 0640 with one ACL entry letting the
# build account read it; agent accounts, standard ones, can't. (Linux has no agent
# accounts, as for the build account's home: root's, 0644.) Why it isn't so
# (printed; status 1), or nothing; with a descriptor number, also that this
# shell's descriptor is on that very file. Status 2: the directories above it
# aren't root's alone, so nothing there may be touched.
tools_lock_problem() { node "$PNPM_CHECK" check-tools-lock "$BUILD_TOOLS.lock" "$BUILDER" "$@"; }

# Root's owner and group, $3's mode and, on macOS, only the build account's ACL entry, on $2. $1: how to run as root.
tools_lock_attributes() {
  "$1" chown "root:$3" "$2"
  "$1" chmod "$4" "$2"
  if [[ "$(uname -s)" == Darwin ]]; then
    "$1" chmod -N "$2"
    "$1" chmod +a "user:$BUILDER allow read" "$2"
  fi
}

# Makes the lock as tools_lock_problem wants it, or keeps it if it is. Never through
# a symlink: one there (or anything but a regular file) stops this before any
# privileged step. A missing one is made whole beside it and linked into place,
# which link(2) does only if nothing's there and without following anything; one
# that's there is fixed in place, never replaced (a build's lock is on that file,
# and one beside it wouldn't keep the two apart). $1: how to run as root.
provision_tools_lock() {
  local root="$1" lock="$BUILD_TOOLS.lock" group mode tmp problem status=0
  if [[ -L "$lock" ]] || { [[ -e "$lock" ]] && [[ ! -f "$lock" ]]; }; then
    die "$lock isn't a regular file (a symlink?); remove it (sudo rm -i \"$lock\") and rerun ./install.sh"
  fi
  problem="$(tools_lock_problem 2>&1)" || status=$?
  ((status == 0)) && return 0
  ((status == 1)) || die "the build tools' lock can't be made in its place: $problem"
  if [[ "$(uname -s)" == Darwin ]]; then group=admin mode=640; else group="$(id -gn root)" mode=644; fi
  if [[ -e "$lock" ]]; then
    tools_lock_attributes "$root" "$lock" "$group" "$mode"
  else
    tmp="$("$root" mktemp "$lock.new.XXXXXX")" || die "couldn't make $lock"
    tools_lock_attributes "$root" "$tmp" "$group" "$mode"
    # Another install's, made meanwhile, is kept.
    "$root" ln "$tmp" "$lock" 2>/dev/null || true
    "$root" rm -f "$tmp"
  fi
  problem="$(tools_lock_problem 2>&1)" || die "the build tools' lock isn't as it must be: $problem"
}

# One try at an exclusive flock(2) on this shell's fd 8, by a helper that exits:
# macOS's own perl, util-linux flock(1) elsewhere. Status 0 taken; 75 held by
# another, which only EWOULDBLOCK means; anything else failed (tools_flock_why).
TOOLS_PERL=/usr/bin/perl
tools_flock() {
  local flock
  if [[ "$(uname -s)" == Darwin ]]; then
    [[ -x "$TOOLS_PERL" ]] || return 3
    # shellcheck disable=SC2016 # perl's own variables
    "$TOOLS_PERL" -MFcntl=:flock -MErrno -e 'open(my $f, "<&=", 8) or exit 4; flock($f, LOCK_EX | LOCK_NB) and exit 0; exit(($!{EWOULDBLOCK} || $!{EAGAIN}) ? 75 : 5)'
    return
  fi
  for flock in /usr/bin/flock /bin/flock; do
    if [[ -x "$flock" ]]; then
      "$flock" -x -n -E 75 8
      return
    fi
  done
  return 3
}
tools_flock_why() {
  case "$1" in
    3) echo "neither $TOOLS_PERL (macOS) nor util-linux flock is there to take it with" ;;
    4) echo "$TOOLS_PERL couldn't use this shell's descriptor on it" ;;
    *) echo "flock failed (exit $1)" ;;
  esac
}

# Holds the tools' lock exclusive on this shell's own descriptor of it, fd 8: the
# lock belongs to that open file, so it's this shell's, whatever becomes of the
# helper that took it, and lasts while this shell or anything it started meanwhile
# keeps fd 8 open (sudo closes it in what it runs; nothing started here outlives
# the install), until release_tools_lock, or their exits, however they end. Waits
# while a build uses the tools or another install replaces them, up to
# BLACKSAND_T3_TOOLS_LOCK_WAIT_SECONDS (2 h), saying so once.
hold_tools_lock() {
  local lock="$BUILD_TOOLS.lock" wait="${BLACKSAND_T3_TOOLS_LOCK_WAIT_SECONDS:-7200}" deadline problem status waiting=""
  [[ "$wait" =~ ^[0-9]+$ ]] || wait=7200
  exec 8<"$lock" || die "couldn't open the build tools' lock $lock"
  problem="$(tools_lock_problem 8 2>&1)" || { exec 8<&-; die "the build tools' lock isn't as it must be: $problem"; }
  deadline=$((SECONDS + wait))
  while :; do
    status=0
    tools_flock || status=$?
    ((status == 0)) && return 0
    if ((status != 75)); then
      exec 8<&-
      die "couldn't take the build tools' lock $lock: $(tools_flock_why "$status")"
    fi
    if ((SECONDS >= deadline)); then
      exec 8<&-
      die "gave up after $wait s waiting for the build tools' lock $lock: a build is using the build tools, or another ./install.sh is replacing them (\`lsof $lock\` shows what holds it)"
    fi
    [[ -n "$waiting" ]] || echo "waiting: a build is using the build tools, or another ./install.sh is replacing them ($lock)" >&2
    waiting=1
    sleep 0.25
  done
}
release_tools_lock() { exec 8<&-; }

# Puts the tools moved aside to $2 back in $BUILD_TOOLS, if they aren't there. $1: how to run as root.
restore_build_tools() {
  if ! "$1" test -e "$BUILD_TOOLS" && "$1" test -e "$2"; then "$1" mv "$2" "$BUILD_TOOLS"; fi
}

# Installs them, or keeps them while they pass build_tools_problem, after making the
# tools' lock as it must be. Under that lock, so no build uses them meanwhile and
# no other install works on them, it clears what an install stopped part-way left;
# then a new set is made in a stage of its own beside them and checked, then
# swapped in and checked in place; the set before is kept until then, and put back
# if anything fails or the install is stopped. Modes are set outright, not left to
# the umask, and inherited ACLs cleared. $1: how to run as root (sudo; tests stub it).
install_build_pnpm() {
  local root="${1:-sudo}" group stage old tmp p part problem parts
  group="$(id -gn root)"
  # The directories on the way that aren't there yet: root's, 755.
  IFS=/ read -r -a parts <<<"${BUILD_TOOLS#/}"
  p=""
  for part in "${parts[@]:0:${#parts[@]}-1}"; do
    p="$p/$part"
    if ! "$root" test -d "$p"; then "$root" mkdir "$p" && "$root" chown "root:$group" "$p" && "$root" chmod 755 "$p"; fi
  done
  provision_tools_lock "$root"
  hold_tools_lock
  # An install stopped part-way leaves its stage, or the set before; missing tools are made again.
  "$root" rm -rf "$BUILD_TOOLS".new.* "$BUILD_TOOLS".old.*
  # Fit ones, from before or from another install just now, are kept.
  if build_tools_problem "$BUILD_TOOLS" >/dev/null 2>&1; then
    release_tools_lock
    return 0
  fi
  say "Installing the pinned pnpm for $BUILDER into $BUILD_TOOLS"
  stage="$("$root" mktemp -d "$BUILD_TOOLS.new.XXXXXX")"
  old="$BUILD_TOOLS.old.${stage##*.new.}"
  tmp="$(mktemp -d)"
  pnpm_fetch "$tmp" || { "$root" rm -rf "$stage"; die "couldn't get the pinned pnpm"; }
  "$root" cp -R "$tmp/pnpm" "$tmp/vite-plus" "$stage/"
  rm -rf "$tmp"
  "$root" chown -R "root:$group" "$stage"
  if [[ "$(uname -s)" == Darwin ]]; then "$root" chmod -R -N "$stage"; elif have setfacl; then "$root" setfacl -R -b "$stage"; fi
  "$root" find "$stage" -type d -exec chmod 755 {} +
  "$root" find "$stage" -type f -perm -u+x -exec chmod 755 {} +
  "$root" find "$stage" -type f ! -perm -u+x -exec chmod 644 {} +
  if ! problem="$(build_tools_problem "$stage")"; then
    "$root" rm -rf "$stage"
    die "the build tools made in $stage aren't fit for $BUILDER: $problem"
  fi
  # shellcheck disable=SC2064 # $root and $old as they are now
  trap "restore_build_tools $(printf %q "$root") $(printf %q "$old"); exit 130" INT TERM HUP
  if "$root" test -e "$BUILD_TOOLS"; then "$root" mv "$BUILD_TOOLS" "$old"; fi
  if ! "$root" mv "$stage" "$BUILD_TOOLS"; then
    restore_build_tools "$root" "$old"
    "$root" rm -rf "$stage"
    die "couldn't move the new build tools into $BUILD_TOOLS; the ones before are back"
  fi
  if ! problem="$(build_tools_problem "$BUILD_TOOLS")"; then
    "$root" rm -rf "$BUILD_TOOLS"
    restore_build_tools "$root" "$old"
    die "the build tools put in $BUILD_TOOLS aren't fit for $BUILDER ($problem); the ones before, if any, are back"
  fi
  trap - INT TERM HUP
  "$root" rm -rf "$old"
  release_tools_lock
}

# Installs Rust $RUST_TOOLCHAIN with pinned rustup-init (Linux), as the account
# $1... (as_builder), or as you with no arguments.
install_rust() {
  local triple tmp
  case "$(uname -m)" in
    x86_64) triple=x86_64-unknown-linux-gnu ;;
    aarch64 | arm64) triple=aarch64-unknown-linux-gnu ;;
    *) die "no pinned rustup for $(uname -m)" ;;
  esac
  say "Installing Rust $RUST_TOOLCHAIN (rustup $RUSTUP_VERSION, minimal profile)"
  tmp="$(mktemp -d)"
  fetch_pinned "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/$triple/rustup-init" "$(rustup_sha256 "$triple")" "$tmp/rustup-init" 256
  # shellcheck disable=SC2016 # expanded by the inner sh
  "$@" /bin/sh -c 'set -e; f="$(mktemp)"; trap "rm -f \"$f\"" EXIT; cat >"$f"; chmod 700 "$f"
    "$f" -y --profile minimal --no-modify-path --default-toolchain "$1" >/dev/null' sh "$RUST_TOOLCHAIN" <"$tmp/rustup-init"
  rm -rf "$tmp"
}

# --- macOS ----------------------------------------------------------------------
# Homebrew's tools before macOS's (Apple's git is below the floor) for the rest of
# this run, and so for everything it sets up: the scheduled job keeps this PATH,
# the build account takes its folders outside your home in this order, and the
# app's update button runs with the PATH the job builds with.
homebrew_first() {
  local bin
  bin="$(brew --prefix)/bin"
  [[ "${PATH%%:*}" == "$bin" ]] || export PATH="$bin:$PATH"
  hash -r
}

mac_setup() {
  if ! xcode-select -p >/dev/null 2>&1; then
    xcode-select --install >/dev/null 2>&1 || true
    die "Install the Xcode Command Line Tools (a dialog should have opened), then rerun ./install.sh"
  fi
  if ! have brew; then
    [[ -x /opt/homebrew/bin/brew ]] || die "Homebrew is required (https://brew.sh). Install it, then rerun ./install.sh"
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
  homebrew_first

  local missing=() problem
  if ! git_ok; then
    if brew list --formula git >/dev/null 2>&1; then
      say "Upgrading Homebrew's git"
      brew upgrade git
    else
      missing+=(git)
    fi
  fi
  node_ok || missing+=(node)
  # pnpm comes pinned (install_pnpm), not from Homebrew.
  have cargo || missing+=(rust)
  if ((${#missing[@]})); then
    say "Installing ${missing[*]} with Homebrew"
    brew install "${missing[@]}"
  fi
  have op || { say "Installing the 1Password CLI"; brew install --cask 1password-cli; }
  hash -r
  problem="$(git_problem)" || die "$problem (git on PATH: $(command -v git || echo none)). Run: brew install git"
  node_ok || die "Node $NODE_MAJOR or newer with the Oct 2026 security fixes is required (24.22.1 or later on 24.x, or 26.12.1 or later; found $(node --version)). Run: brew upgrade node"

  if bin/t3 signing status | grep -q "not set up"; then
    [[ -d /Applications/1Password.app ]] || die "Install the 1Password app and sign in, then rerun ./install.sh"
    op vault list >/dev/null 2>&1 ||
      die "Turn on 1Password → Settings → Developer → \"Integrate with 1Password CLI\", then rerun ./install.sh"
    if op item get "$OP_ITEM" --vault "$VAULT" >/dev/null 2>&1; then
      say "Importing the shared signing identity from 1Password ($VAULT)"
      bin/t3 signing import --vault "$VAULT"
    elif security find-identity -v -p codesigning "$HOME/Library/Keychains/login.keychain-db" |
      grep -qE '"(Apple Development|Developer ID Application): '; then
      say "Sharing your Apple Development certificate through 1Password ($VAULT)"
      bin/t3 signing adopt --vault "$VAULT"
    else
      say "No Apple Development certificate found; creating a self-signed one in \"$VAULT\""
      say "Keychain will ask again after each update until you run: blacksand t3 signing adopt --vault \"$VAULT\" (packages/t3/docs/install/signing-macos.md)"
      bin/t3 signing init --vault "$VAULT"
    fi
  else
    say "Signing certificate already set up"
  fi
}

# --- Linux ----------------------------------------------------------------------
NODE_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/blacksand/t3/node"

install_node() {
  local arch
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported CPU: $(uname -m)" ;;
  esac
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" tmp sums file want
  tmp="$(mktemp -d)"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")"
  file="$(awk -v suffix="linux-$arch.tar.xz" '$2 ~ suffix"$" { print $2; exit }' <<<"$sums")"
  want="$(awk -v f="$file" '$2 == f { print $1 }' <<<"$sums")"
  [[ -n "$file" && -n "$want" ]] || die "couldn't find a Node $NODE_MAJOR download for linux-$arch"
  say "Installing $file into $NODE_HOME"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  echo "$want  $tmp/$file" | sha256sum -c - >/dev/null || die "Node download failed its checksum"
  rm -rf "$NODE_HOME" && mkdir -p "$NODE_HOME"
  tar -xJf "$tmp/$file" -C "$NODE_HOME" --strip-components=1
  rm -rf "$tmp"
}

linux_setup() {
  [[ -r /etc/os-release ]] || die "can't identify this Linux distribution (/etc/os-release missing)"
  # shellcheck disable=SC1091
  . /etc/os-release
  local family="" sudo=sudo
  case " ${ID:-} ${ID_LIKE:-} " in
    *" arch "*) family=arch ;;
    *" ubuntu "* | *" debian "*) family=debian ;;
    *" fedora "* | *" rhel "* | *" centos "*) family=rhel ;;
  esac
  [[ -n "$family" ]] || die "unsupported distro: ${PRETTY_NAME:-unknown}. Supported: Omarchy/Arch, Ubuntu/Debian, Fedora/RHEL."

  # curl/git only when missing: Fedora/RHEL ship curl-minimal, which conflicts
  # with the full curl package.
  local common=()
  have curl || common+=(curl)
  have git || common+=(git)
  # Upstream's Linux build needs a C toolchain, libsecret headers, pkg-config and
  # ImageMagick (upstream's docs/operations/development.md, "Linux AppImage prerequisites").
  say "Installing system packages (${PRETTY_NAME:-$ID})"
  case "$family" in
    arch)
      # No -Sy: Arch doesn't support partial upgrades, and a full -Syu is your call.
      $sudo pacman -S --needed --noconfirm "${common[@]}" base-devel libsecret pkgconf imagemagick python xz tar ||
        die "pacman couldn't install the build packages. Update the system first (omarchy-update, or sudo pacman -Syu), then rerun ./install.sh"
      ;;
    debian)
      $sudo apt-get update -qq
      $sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${common[@]}" ca-certificates \
        build-essential libsecret-1-dev pkg-config imagemagick python3 xz-utils
      ;;
    rhel)
      # RHEL clones keep ImageMagick in EPEL and libsecret-devel in CRB.
      if [[ "${ID:-}" != fedora ]]; then
        case "${ID:-}" in
          rhel)
            $sudo dnf install -y -q "https://dl.fedoraproject.org/pub/epel/epel-release-latest-$(rpm -E %rhel).noarch.rpm"
            $sudo subscription-manager repos --enable "codeready-builder-for-rhel-$(rpm -E %rhel)-$(uname -m)-rpms"
            ;;
          *)
            $sudo dnf install -y -q epel-release dnf-plugins-core
            $sudo dnf config-manager --set-enabled crb
            ;;
        esac
      fi
      $sudo dnf install -y -q "${common[@]}" gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick python3 xz tar
      ;;
  esac

  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$NODE_HOME/bin:$PATH"
  node_ok || install_node
  local problem
  problem="$(git_problem)" || die "$problem (git on PATH: $(command -v git || echo none)). Install a newer git than ${PRETTY_NAME:-this distro} ships (e.g. Ubuntu: the git-core PPA), then rerun ./install.sh"

  # Ubuntu 23.10+ blocks unprivileged user namespaces, which Electron's own
  # (Chromium) sandbox needs. Allow them for exactly the installed binary; its
  # path stays fixed across updates.
  local restrict=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
  if [[ -r "$restrict" && "$(cat "$restrict")" == 1 && ! -f /etc/apparmor.d/blacksand ]]; then
    local exe="${XDG_DATA_HOME:-$HOME/.local/share}/blacksand/t3/app/t3code"
    say "Adding an AppArmor profile so Electron's sandbox can start ($exe)"
    $sudo tee /etc/apparmor.d/blacksand >/dev/null <<EOF
abi <abi/4.0>,
include <tunables/global>

profile blacksand $exe flags=(unconfined) {
  userns,
  include if exists <local/blacksand>
}
EOF
    $sudo apparmor_parser -r /etc/apparmor.d/blacksand
  fi
}

# --- build account ----------------------------------------------------------------
BUILDER=_blacksand-build
if [[ "$(uname -s)" == Darwin ]]; then
  BUILDER_HOME=/private/var/blacksand-build
else
  BUILDER_HOME=/var/lib/blacksand-build
fi

builder_user_mac() {
  dscl . -read "/Users/$BUILDER" >/dev/null 2>&1 && return
  local id=450
  while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$id" ||
    dscl . -list /Groups PrimaryGroupID | awk '{print $2}' | grep -qx "$id"; do
    id=$((id + 1))
  done
  sudo dscl . -create "/Groups/$BUILDER"
  sudo dscl . -create "/Groups/$BUILDER" PrimaryGroupID "$id"
  sudo dscl . -create "/Groups/$BUILDER" RealName "Blacksand T3 builder"
  sudo dscl . -create "/Users/$BUILDER"
  sudo dscl . -create "/Users/$BUILDER" UniqueID "$id"
  sudo dscl . -create "/Users/$BUILDER" PrimaryGroupID "$id"
  sudo dscl . -create "/Users/$BUILDER" UserShell /usr/bin/false
  sudo dscl . -create "/Users/$BUILDER" NFSHomeDirectory "$BUILDER_HOME"
  sudo dscl . -create "/Users/$BUILDER" RealName "Blacksand T3 builder"
  sudo dscl . -create "/Users/$BUILDER" Password '*'
  sudo dscl . -create "/Users/$BUILDER" IsHidden 1
}

builder_user_linux() {
  id "$BUILDER" >/dev/null 2>&1 && return
  sudo useradd --system --home-dir "$BUILDER_HOME" --create-home \
    --shell "$(command -v nologin || echo /bin/false)" --comment "Blacksand T3 builder" "$BUILDER"
}

# The build account's home. On macOS, mode 700 with one ACL entry, on the folder
# itself, letting you list and pass through it: you read the builds it hands
# back and its upstream mirror (both readable inside), and nobody else, agent
# accounts included, can open it at all. (Linux has no agent accounts: there it
# stays 755.)
builder_home() {
  if [[ "$(uname -s)" != Darwin ]]; then
    sudo install -d -o "$BUILDER" -g "$(id -gn "$BUILDER")" -m 755 "$BUILDER_HOME"
    return
  fi
  sudo install -d -o "$BUILDER" -g "$(id -gn "$BUILDER")" -m 700 "$BUILDER_HOME"
  sudo chmod -N "$BUILDER_HOME"
  sudo chmod +a "user:$(id -un) allow list,search,readattr,readextattr,readsecurity" "$BUILDER_HOME"
  [[ -r "$BUILDER_HOME" && -x "$BUILDER_HOME" ]] || die "you can't open $BUILDER_HOME, where builds come back to you; see: ls -led $BUILDER_HOME"
}

# Runs a command as the build account, with its own tools first on PATH, from /:
# the folder you're in (the clone) is in your home, which it can't open.
as_builder() {
  (cd / && sudo -n -u "$BUILDER" -H env HOME="$BUILDER_HOME" \
    PATH="$BUILDER_HOME/node/bin:$BUILDER_HOME/.local/bin:$BUILDER_HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" "$@")
}

# Whether the build account can be set up: it needs sudo once. Where it can't,
# the install stops here, before any upstream code runs, unless
# --unisolated-build said to build as you (status 1).
builder_sudo() {
  local why="sudo isn't installed"
  if have sudo; then
    say "Setting up the build account $BUILDER (sudo asks for your password)"
    sudo -v && return 0
    why="sudo didn't authorize you"
  fi
  if ((UNISOLATED)); then
    warn "$why, so this install builds as you (--unisolated-build): upstream's dependency and build scripts run with your files and credentials"
    return 1
  fi
  die "$why. Blacksand T3 runs upstream's dependency and build scripts only as its build account $BUILDER, which needs sudo once to set up; rerun ./install.sh from an account that can use sudo. To build as you instead, with those scripts able to read your files and credentials: ./install.sh --unisolated-build"
}

# Called as a plain command, never in a condition, so `set -e` stops the
# installer at the first step that fails. The marker that makes builds use the
# account, and the cleanup of your old build data, come only after its toolchain
# checks out.
setup_builder() {
  case "$(uname -s)" in
    Darwin) builder_user_mac ;;
    *) builder_user_linux ;;
  esac
  builder_home
  # Lets you (and the scheduled job) act as the build account without a password.
  # Only in that direction: the build account gets no sudo at all.
  local rule
  rule="$(mktemp)"
  printf '%s ALL=(%s) NOPASSWD: ALL\n' "$(id -un)" "$BUILDER" >"$rule"
  sudo visudo -cf "$rule" >/dev/null || die "the sudo rule for $BUILDER didn't validate"
  sudo install -m 440 -o root -g "$(id -gn root)" "$rule" /etc/sudoers.d/blacksand
  rm -f "$rule"
  as_builder true 2>/dev/null ||
    die "sudo can't switch to $BUILDER; make sure /etc/sudoers includes /etc/sudoers.d"

  # Its own toolchain where yours lives in your home (which it can't read). On
  # macOS it shares Homebrew's Node and Rust, which mac_setup checked.
  if [[ "$(uname -s)" == Linux ]]; then
    if ! as_builder node -e "$NODE_CHECK" "$NODE_PATCHED" "$NODE_MAJOR" 2>/dev/null; then
      as_builder bash -c "set -euo pipefail; $(declare -f say die install_node); NODE_MAJOR=$NODE_MAJOR NODE_HOME=$BUILDER_HOME/node install_node"
    fi
    [[ -x "$BUILDER_HOME/.cargo/bin/cargo" ]] || install_rust as_builder
  fi
  install_build_pnpm sudo
  as_builder node -e "$NODE_CHECK" "$NODE_PATCHED" "$NODE_MAJOR" ||
    die "$BUILDER's Node ($(as_builder node --version 2>&1)) isn't Node $NODE_MAJOR+ with the Oct 2026 security fixes"
  as_builder cargo --version >/dev/null || die "$BUILDER can't run cargo (on macOS it uses Homebrew's: brew install rust)"
  local problem
  problem="$(git_problem as_builder git)" || die "$BUILDER's git: $problem"

  # Builds run as this account so their scripts can't read your home; make sure
  # they can't (on macOS it shares your staff group, which can read a 0750 home).
  if as_builder test -r "$HOME" || as_builder test -x "$HOME"; then
    say "Making $HOME private (chmod go-rwx): the build account could read it"
    chmod go-rwx "$HOME"
    if as_builder test -r "$HOME" || as_builder test -x "$HOME"; then
      die "$BUILDER can still open $HOME (an ACL entry?); make it private, then rerun"
    fi
  fi

  # Hand over the mirror already fetched here, so the first build doesn't clone again.
  if [[ -d build/upstream/.git && ! -d "$BUILDER_HOME/upstream" ]]; then
    tar -C build -cf - upstream | as_builder tar -C "$BUILDER_HOME" -xf -
  fi
  as_builder touch "$BUILDER_HOME/.blacksand-builder"
  # Build data from before the build account existed; it keeps its own now.
  rm -rf upstream build
}

# Building as you (--unisolated-build) needs pnpm and Rust here too.
setup_own_toolchain() {
  if ! pnpm_installed "$HOME/.local"; then install_pnpm "$HOME/.local"; fi
  export PATH="$HOME/.local/bin:$PATH"
  if ! have cargo; then
    if [[ "$(uname -s)" == Linux ]]; then install_rust; else brew install rust; fi
  fi
}

# --- main -----------------------------------------------------------------------
main() {
  refuse_legacy_install
  case "$(uname -s)" in
    Darwin) mac_setup ;;
    Linux) linux_setup ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac

  # The role, the locations this environment chose and whether builds may run as
  # you, for every later run (scheduled, from the app, by hand):
  # lib/install-config.mjs. Saved without --unisolated-build, a run that finds no
  # build account refuses to build.
  if builder_sudo; then
    setup_builder
    bin/t3 configure --role "$ROLE"
  else
    setup_own_toolchain
    bin/t3 configure --role "$ROLE" --unisolated-build
    warn "Building as you (--unisolated-build): no build account keeps upstream's scripts away from your files"
  fi

  say "Building and installing Blacksand T3 (a few minutes on first run)"
  bin/t3 update

  if [[ "$DAY" == hourly ]]; then say "Scheduling the update check: hourly, and on update requests"; else say "Scheduling the update: ${DAY}, ${HOUR}:00"; fi
  if [[ "$ROLE" == host ]]; then say "It runs as a LaunchDaemon (as you), so it keeps going with nobody logged in"; fi
  bin/t3 schedule --hour "$HOUR" --day "$DAY" || say "Couldn't schedule automatic updates here; run blacksand t3 update by hand."

  say "Done"
  bin/t3 status
  if [[ "$(uname -s)" == Linux && ":$PATH:" == *":$NODE_HOME/bin:"* ]]; then
    echo
    echo "To run blacksand t3 by hand, add this to your shell profile:"
    echo "  export PATH=\"$NODE_HOME/bin:\$HOME/.local/bin:\$HOME/.cargo/bin:\$PATH\""
  fi
  case "$ROLE" in
    ui)
      printf '\nOpen "Blacksand T3" from your app launcher, or run: blacksand t3 launch\n'
      ;;
    host)
      cat <<'NEXT'

Next, for each account agents run in (packages/t3/docs/accounts/agent-accounts.md), e.g.:
  sudo scripts/add-agent-account.sh agent-claude --key ~/.ssh/blacksand.pub
then turn on Remote Login and run that command again. Signed in as the account
(ssh agent-claude@localhost): install the provider CLIs on its own PATH, run
`codex login` and `claude setup-token`, then
/usr/local/libexec/blacksand/set-claude-token
NEXT
      ;;
    both)
      cat <<'NEXT'

Open "Blacksand T3" from your app launcher, or run: blacksand t3 launch
For the local standby lane (packages/t3/docs/install/standby.md), e.g.:
  sudo scripts/add-agent-account.sh agent-standby --loopback-only --key ~/.ssh/blacksand.pub
NEXT
      ;;
  esac
}

# Sourced (tests): functions only.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main; fi
