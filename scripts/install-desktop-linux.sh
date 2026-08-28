#!/usr/bin/env bash
#
# Allr Desktop — Linux installer.
#
#   curl -fsSL https://raw.githubusercontent.com/allr-ajmx/allr-agent/main/scripts/install-desktop-linux.sh | bash
#
# Downloads the release tarball, verifies it against the release's own
# SHA256SUMS.txt, and hands off to the install.sh INSIDE the tarball so there is
# exactly one definition of where files go. Installs to ~/.local by default; no
# root, no package manager.
#
# NOT to be confused with scripts/install.sh, which installs the Python CLI and
# is what https://allr.work/install.sh serves. This one installs the desktop app.
#
# On resolving "latest": deliberately NOT /releases/latest. The desktop release
# is published with --latest=false on purpose -- /releases/latest must keep
# resolving to the Python CalVer release that scripts/install.sh depends on --
# so asking GitHub for "latest" returns a release with no desktop assets at all.
# The real pointer is latest.json on the fixed `desktop-updater` prerelease tag,
# which is also what the app's own updater reads.

set -euo pipefail

REPO="${ALLR_REPO:-allr-ajmx/allr-agent}"
UPDATER_TAG="desktop-updater"
# Where release assets are fetched from. Overridable for a mirror, an
# air-gapped copy, or a local file server; the layout underneath must match
# GitHub's (<base>/<tag>/<asset>).
RELEASE_BASE="${ALLR_RELEASE_BASE_URL:-https://github.com/$REPO/releases/download}"

prefix="$HOME/.local"
version=""
action=install

say()  { printf '%s\n' "$*"; }
warn() { printf '\033[0;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }

usage() {
  cat <<USAGE
Allr Desktop installer (Linux)

  --version X.Y.Z   install this version instead of the newest
  --prefix=DIR      install under DIR (default: ~/.local)
  --system          shorthand for --prefix=/usr/local (needs write access)
  --uninstall       remove a previous install (pass the same --prefix/--system)
  -h, --help        this

Prefer your distribution's package if you have one: the .deb and .rpm on the
same release declare their dependencies, and this tarball cannot.

Environment:
  ALLR_REPO               owner/repo to install from
  ALLR_RELEASE_BASE_URL   mirror or local server holding the release assets
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:?--version needs a value}"; shift 2 ;;
    --version=*) version="${1#--version=}"; shift ;;
    --prefix=*) prefix="${1#--prefix=}"; shift ;;
    --system) prefix=/usr/local; shift ;;
    --uninstall) action=uninstall; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# --- uninstall needs none of the network machinery below ----------------------
if [ "$action" = uninstall ]; then
  bin="$prefix/bin/allr"
  [ -e "$bin" ] || die "no Allr install found at $bin"
  rm -f "$bin" "$prefix/share/applications/allr.desktop"
  for size in 32x32 128x128 256x256; do
    rm -f "$prefix/share/icons/hicolor/$size/apps/allr.png"
  done
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$prefix/share/applications" >/dev/null 2>&1 || true
  ok "Removed Allr from $prefix"
  exit 0
fi

# --- preflight ----------------------------------------------------------------
arch="$(uname -m)"
[ "$arch" = "x86_64" ] || die "unsupported architecture: $arch (only x86_64 is built today)"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1"; }
  fetch_to() { curl -fsSL --progress-bar "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO- "$1"; }
  fetch_to() { wget -q --show-progress -O "$2" "$1"; }
else
  die "need curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  sha256_of() { echo ""; }
fi

# --- resolve the version ------------------------------------------------------
if [ -z "$version" ]; then
  say "Resolving the current desktop version…"
  manifest="$(fetch "$RELEASE_BASE/$UPDATER_TAG/latest.json" || true)"
  version="$(printf '%s' "$manifest" \
    | tr ',' '\n' | grep -m1 '"version"' \
    | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)"

  # Fallback: no updater pointer yet (or a network that ate it). Ask the API for
  # the newest desktop-v* tag directly, skipping prereleases.
  if [ -z "$version" ]; then
    warn "no $UPDATER_TAG pointer; falling back to the releases list"
    version="$(fetch "https://api.github.com/repos/$REPO/releases?per_page=50" \
      | tr ',' '\n' | grep '"tag_name"' \
      | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"desktop-v\([^"]*\)".*/\1/' \
      | grep -v '"' | grep -v -- '-' | head -1 || true)"
  fi

  [ -n "$version" ] || die "could not determine the latest desktop version; pass --version X.Y.Z"
fi

tag="desktop-v$version"
asset="Allr_${version}_linux_x86_64.tar.gz"
base="$RELEASE_BASE/$tag"

say "Installing Allr $version into $prefix"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- download -----------------------------------------------------------------
say "Downloading $asset…"
fetch_to "$base/$asset" "$tmp/$asset" || die \
  "no $asset on $tag.

This release predates the tarball (it shipped an AppImage instead, which was
withdrawn because it bundled a WebKitGTK that cannot start on modern hosts).
Install the .deb or .rpm from https://github.com/$REPO/releases/tag/$tag, or
pass --version with a newer release."

# --- verify -------------------------------------------------------------------
# Linux artifacts carry no code signature, so the published checksum is the only
# integrity signal there is. A missing SHA256SUMS.txt warns rather than fails --
# refusing to install over a missing convenience file would be worse than saying
# so out loud.
actual="$(sha256_of "$tmp/$asset")"
if [ -z "$actual" ]; then
  warn "no sha256sum/shasum available — skipping checksum verification"
elif sums="$(fetch "$base/SHA256SUMS.txt" 2>/dev/null)" && [ -n "$sums" ]; then
  # Match on the BASENAME. The publish job generates this file with `find .`,
  # so every name carries a `./` prefix, and sha256sum's binary mode would add
  # a `*`. A naive substring match silently finds nothing and skips
  # verification -- worse than failing, because it still looks like it checked.
  expected="$(printf '%s' "$sums" | awk -v want="$asset" '
    {
      name = $2
      sub(/^\.\//, "", name)
      sub(/^\*/, "", name)
      if (name == want) { print $1; exit }
    }')"
  if [ -z "$expected" ]; then
    warn "$asset is not listed in SHA256SUMS.txt — cannot verify"
  elif [ "$expected" = "$actual" ]; then
    ok "checksum verified"
  else
    die "CHECKSUM MISMATCH
  expected $expected
  got      $actual
Refusing to install. Download it by hand and check the release page."
  fi
else
  warn "could not fetch SHA256SUMS.txt — skipping checksum verification"
fi

# --- install ------------------------------------------------------------------
# A truncated or corrupt archive that nonetheless matched its checksum means the
# published checksum is wrong, not that the download broke -- say which, because
# the two have very different fixes.
tar -xzf "$tmp/$asset" -C "$tmp" 2>/dev/null || die \
  "$asset downloaded and matched its checksum but will not extract.
That points at a bad published artifact rather than a bad download. Please
report it at https://github.com/$REPO/issues"
unpacked="$(find "$tmp" -maxdepth 1 -type d -name 'Allr_*' -print -quit)"
[ -n "$unpacked" ] || die "unexpected tarball layout"
[ -x "$unpacked/install.sh" ] || die "tarball has no install.sh"

# The tarball's own installer decides the layout; this script only gets it here.
"$unpacked/install.sh" --prefix="$prefix"

# --- report what the host is still missing ------------------------------------
# The tarball links the system's libraries by design, which is exactly why it
# works where a self-contained bundle does not -- but it means an incomplete
# host shows up as a silent failure to start. Name the missing libraries now.
missing="$(ldd "$prefix/bin/allr" 2>/dev/null | awk '/not found/ {print "    " $1}' || true)"
if [ -n "$missing" ]; then
  warn "these shared libraries are missing on this machine:"
  printf '%s\n' "$missing" >&2
  cat >&2 <<HINT

  Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 \\
                   libayatana-appindicator3-1 libasound2
  Fedora/RHEL:   sudo dnf install webkit2gtk4.1 gtk3 \\
                   libayatana-appindicator-gtk3 alsa-lib
  Arch/Manjaro:  sudo pacman -S --needed webkit2gtk-4.1 gtk3 \\
                   libayatana-appindicator alsa-lib
HINT
else
  ok "all shared libraries resolve"
fi

case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *) warn "$prefix/bin is not on your PATH — add it to run 'allr' from a shell" ;;
esac

ok "Allr $version installed. Launch it from your app menu, or run: $prefix/bin/allr"
