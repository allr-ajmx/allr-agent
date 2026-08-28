#!/usr/bin/env bash
#
# Build the distro-agnostic Linux tarball: the Allr binary plus the desktop
# entry, icons and an installer, in a form a user can unpack and run.
#
# This replaces the AppImage, which was removed from the bundle targets because
# it is broken by construction. An AppImage carries its OWN copy of WebKitGTK
# taken from the build runner, and Ubuntu 22.04's WebKitGTK cannot initialise
# EGL against a modern host graphics stack -- the shipped Allr_0.0.7 AppImage
# put up a window and never painted a pixel, aborting with
# "Could not create default EGL display: EGL_BAD_PARAMETER". The identical
# binary linked against the host's WebKitGTK renders fine, which is why the
# .deb and .rpm were unaffected and why this tarball is not a workaround but
# the right shape: it ships OUR code and links the system's WebKitGTK, exactly
# as the packages do.
#
# usage: package-linux-tarball.sh <binary> <version> <out-dir>

set -euo pipefail

binary="${1:?usage: package-linux-tarball.sh <binary> <version> <out-dir>}"
version="${2:?missing version}"
out_dir="${3:?missing output directory}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$here/../apps/hermes-universal/src-tauri"

[ -x "$binary" ] || { echo "no executable at $binary" >&2; exit 1; }

name="Allr_${version}_linux_x86_64"
stage="$(mktemp -d)"
root="$stage/$name"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$root/bin" "$root/share/icons"
install -m755 "$binary" "$root/bin/allr"

# Flat, and named by size rather than dropped into a hicolor tree: install.sh
# is what decides where they land, and it targets either ~/.local or /usr/local
# depending on how it was invoked.
for size in 32x32 128x128 256x256; do
  src="$app/icons/${size}.png"
  [ "$size" = 256x256 ] && src="$app/icons/128x128@2x.png"
  [ -f "$src" ] && install -m644 "$src" "$root/share/icons/allr-${size}.png"
done

# NOT shipped pre-written: the Exec line has to name the absolute path the
# binary actually ended up at, and that is only known at install time.
cat > "$root/install.sh" <<'INSTALLER'
#!/usr/bin/env sh
#
# Install Allr for the current user (default) or system-wide (--system).
# Undo either with the matching --uninstall.

set -eu

prefix="$HOME/.local"
action=install

for arg in "$@"; do
  case "$arg" in
    --system) prefix=/usr/local ;;
    --prefix=*) prefix="${arg#--prefix=}" ;;
    --uninstall) action=uninstall ;;
    -h|--help)
      cat <<USAGE
Allr installer

  ./install.sh                 install into ~/.local
  ./install.sh --system        install into /usr/local (needs write access)
  ./install.sh --prefix=DIR    install into DIR
  ./install.sh --uninstall     remove a previous install (add --system/--prefix
                               if that is how it was installed)
USAGE
      exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

bin_dir="$prefix/bin"
app_dir="$prefix/share/applications"
icon_dir="$prefix/share/icons/hicolor"
desktop="$app_dir/allr.desktop"

if [ "$action" = uninstall ]; then
  rm -f "$bin_dir/allr" "$desktop"
  for size in 32x32 128x128 256x256; do
    rm -f "$icon_dir/$size/apps/allr.png"
  done
  # Refresh, do NOT delete mimeinfo.cache: $app_dir is shared with every other
  # application installed under this prefix.
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$app_dir" >/dev/null 2>&1 || true
  echo "Removed Allr from $prefix"
  exit 0
fi

here="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$bin_dir" "$app_dir"
cp "$here/bin/allr" "$bin_dir/allr"
chmod 755 "$bin_dir/allr"

for size in 32x32 128x128 256x256; do
  icon="$here/share/icons/allr-$size.png"
  [ -f "$icon" ] || continue
  mkdir -p "$icon_dir/$size/apps"
  cp "$icon" "$icon_dir/$size/apps/allr.png"
done

cat > "$desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Allr
Comment=Allr — an AI agent client
Exec=$bin_dir/allr
Icon=allr
Terminal=false
Categories=Development;
StartupWMClass=hermes-universal
DESKTOP

# Best effort: a missing update-desktop-database only delays the launcher
# noticing, and is not a reason to report a failed install.
command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$app_dir" >/dev/null 2>&1 || true

echo "Installed Allr to $bin_dir/allr"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Note: $bin_dir is not on your PATH." ;;
esac
INSTALLER
chmod 755 "$root/install.sh"

cat > "$root/README.md" <<README
# Allr $version — Linux

    ./install.sh              # into ~/.local
    ./install.sh --system     # into /usr/local
    ./install.sh --uninstall  # undo

Or just run \`./bin/allr\` in place; nothing here needs to be installed to work.

## Requirements

This tarball ships Allr and nothing else, and links your distribution's
libraries — which is precisely why it works where a self-contained bundle does
not. Install these first if they are missing:

| distro | packages |
| --- | --- |
| Debian / Ubuntu | \`libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 libasound2\` |
| Fedora / RHEL | \`webkit2gtk4.1 gtk3 libayatana-appindicator-gtk3 alsa-lib\` |
| Arch / Manjaro | \`webkit2gtk-4.1 gtk3 libayatana-appindicator alsa-lib\` |

Prefer the \`.deb\` or \`.rpm\` if your distribution uses one: they declare these
dependencies so your package manager pulls them in for you.

## What you do not get here

The polkit action behind the credential unlock is installed only by the \`.deb\`
and \`.rpm\` (to \`/usr/share/polkit-1/actions/\`). Without it Allr reports no
system gate and credential storage stays ungated — the app is fully usable,
it just cannot ask polkit to re-authenticate you.
README

mkdir -p "$out_dir"
tar -czf "$out_dir/${name}.tar.gz" -C "$stage" "$name"
echo "$out_dir/${name}.tar.gz"
