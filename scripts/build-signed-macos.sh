#!/usr/bin/env bash
# Build a Developer ID signed (and, if configured, notarized) macOS bundle.
#
# This exists so the keychain-prompt fix can be PROVEN locally before any repo
# secret is set. Our released bundles are ad-hoc signed, and an ad-hoc signature
# gives the macOS login keychain no code identity to bind an ACL to -- so every
# credential read and write raises a password dialog, several times per launch,
# and "Always Allow" cannot make it stop. Only a real signature fixes that.
#
# Signing and notarization are separate:
#
#   * SIGNING (APPLE_SIGNING_IDENTITY) is what stops the keychain prompts.
#   * NOTARIZATION (APPLE_API_*) is what stops Gatekeeper's "cannot be opened"
#     warning on a downloaded build. Useful, but a different complaint.
#
# So this script runs with signing alone and simply says notarization was
# skipped, rather than refusing to produce the artifact that answers the
# question you are most likely asking.
#
# Environment (same names as .github/workflows/release-desktop.yml):
#   APPLE_SIGNING_IDENTITY   required, e.g. 'Developer ID Application: NAME (TEAMID)'
#   APPLE_API_KEY            optional, 10-character App Store Connect key id
#   APPLE_API_ISSUER         optional, issuer UUID
#   APPLE_API_KEY_PATH       optional, path to AuthKey_<key id>.p8
#
# Unlike the workflow, this REFUSES to run unsigned. The workflow is
# optional-by-presence on purpose (a fork with no certificate still gets
# artifacts); here, an unsigned bundle is the exact thing being debugged, so
# producing one silently would defeat the point.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="$repo_root/apps/hermes-universal"
target="${ALLR_MACOS_TARGET:-universal-apple-darwin}"

die() { printf '\nerror: %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "this only builds on macOS"

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  cat >&2 <<'MSG'
error: APPLE_SIGNING_IDENTITY is not set, and an unsigned build is the problem
       this script exists to rule out.

Available signing identities on this machine:
MSG
  security find-identity -v -p codesigning >&2 || true
  cat >&2 <<'MSG'

Pick the "Developer ID Application: ..." line -- NOT "Apple Distribution",
which is a Mac App Store identity and produces a bundle Gatekeeper rejects on
download. Then:

  export APPLE_SIGNING_IDENTITY='Developer ID Application: NAME (TEAMID)'

MSG
  exit 1
fi

security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY" \
  || die "no codesigning identity on this machine matches APPLE_SIGNING_IDENTITY:
       $APPLE_SIGNING_IDENTITY
       Run 'security find-identity -v -p codesigning' and copy a name verbatim."

notarize=1
for var in APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH; do
  [[ -n "${!var:-}" ]] || notarize=0
done

if (( notarize )); then
  [[ -f "$APPLE_API_KEY_PATH" ]] || die "APPLE_API_KEY_PATH does not exist: $APPLE_API_KEY_PATH"
  echo "==> signing as: $APPLE_SIGNING_IDENTITY (with notarization)"
else
  echo "==> signing as: $APPLE_SIGNING_IDENTITY"
  echo "    notarization SKIPPED (APPLE_API_KEY / APPLE_API_ISSUER / APPLE_API_KEY_PATH not all set)."
  echo "    The build will still be signed, which is what stops the keychain prompts."
  # Unset rather than leave partially set: tauri decides to notarize on the
  # presence of these, and a half-set trio fails late, after the whole build.
  unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
fi

# The first signed build on a machine pops ONE build-time dialog -- "codesign
# wants to use key ... in your keychain". That one is expected and is not the
# bug: choose "Always Allow" so later builds run unattended.
echo "==> building ($target); the first signed build may ask codesign for keychain access"
( cd "$app_dir" && npm run tauri -- build --target "$target" )

bundle="$(find "$app_dir/src-tauri/target/$target/release/bundle/macos" \
  -maxdepth 1 -name '*.app' -print -quit 2>/dev/null || true)"
[[ -n "$bundle" ]] || die "the build produced no .app under target/$target/release/bundle/macos"

echo
echo "==> verifying $bundle"
codesign -dv --verbose=4 "$bundle" 2>&1 | sed 's/^/    /'

info="$(codesign -dv --verbose=4 "$bundle" 2>&1)"

grep -q 'Signature=adhoc' <<<"$info" \
  && die "still ad-hoc signed -- the identity was not applied, and the keychain prompts will not stop"
grep -q 'TeamIdentifier=not set' <<<"$info" \
  && die "no TeamIdentifier -- this is not a Developer ID signature"
# entitlements.plist only takes effect under the hardened runtime, and without it
# the microphone returns silence with no error and no log line.
grep -q 'flags=.*runtime' <<<"$info" \
  || die "the hardened runtime flag is missing -- entitlements.plist will not apply"

echo
echo "==> entitlements"
codesign -d --entitlements :- "$bundle" 2>/dev/null | sed 's/^/    /'

echo
echo "==> Gatekeeper"
if spctl -a -vvv -t exec "$bundle" 2>&1 | sed 's/^/    /'; then
  :
elif (( notarize )); then
  die "Gatekeeper rejected a build that was supposed to be notarized"
else
  echo "    (expected: signed but not notarized. Notarization is what fixes this,"
  echo "     not signing -- and it is not what causes the keychain prompts.)"
fi

cat <<MSG

Signed: $bundle

To answer the original question, install it and count the dialogs:

  rm -rf /Applications/$(basename "$bundle")
  cp -R "$bundle" /Applications/
  open /Applications/$(basename "$bundle")

Expect ONE Touch ID prompt -- that is the app's own credential gate and is meant
to be there -- and ZERO macOS keychain password dialogs. Quit and relaunch to
confirm it holds, which is the part an ad-hoc build fails.
MSG
