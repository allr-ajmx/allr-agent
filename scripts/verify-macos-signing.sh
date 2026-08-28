#!/usr/bin/env bash
# Assert that a macOS .app is signed the way it claims to be.
#
# One copy of these checks, called from two places that used to hand-maintain
# their own: `.github/workflows/release-desktop.yml` and
# `scripts/build-signed-macos.sh`. They had drifted, and not cosmetically -- the
# workflow treated ANY Gatekeeper rejection as fatal, which fails every
# signed-but-not-notarized build, while the local script correctly tolerated it.
# Two copies of a security assertion is one copy too many.
#
# What is checked, and why each one earns its place:
#
#   Signature=adhoc      An ad-hoc signature gives the login keychain no code
#                        identity to bind an ACL to, so macOS re-prompts for the
#                        keychain password and "Always Allow" cannot stick. This
#                        is THE check -- it is the bug this script exists for.
#   TeamIdentifier       Present only on a real Developer ID signature. An
#                        ad-hoc bundle reports "not set".
#   hardened runtime     entitlements.plist only takes effect under it. Without
#                        it the microphone returns silence with no error, no
#                        prompt and no log line -- and only in the signed
#                        artifact, so a dev build will never show you.
#   Gatekeeper (spctl)   Whether a DOWNLOADED copy would open. Fatal only with
#                        --expect-notarized, because signing alone is always
#                        rejected here and that is not a signing failure.
#   stapled ticket       Only under --expect-notarized. spctl can be satisfied
#                        by an ONLINE ticket lookup, so a notarized-but-
#                        unstapled bundle passes it on a networked CI runner
#                        and then fails on a user's machine that is offline or
#                        behind a proxy. `stapler validate` reads the ticket
#                        out of the bundle itself, and is the only one of these
#                        that can tell those two apart.
#
# Usage:
#   verify-macos-signing.sh --require-signed    [--expect-notarized] <bundle.app>
#   verify-macos-signing.sh --warn-if-unsigned  [--expect-notarized] <bundle.app>
#
#   --require-signed     an unsigned bundle is a failure. Use where signing was
#                        configured and is therefore expected to have happened.
#   --warn-if-unsigned   an unsigned bundle is reported and tolerated. This is
#                        the optional-by-presence contract a fork with no
#                        certificate needs -- it must still BUILD.
#
# Emits ::error:: / ::warning:: annotations under GitHub Actions, plain prose
# elsewhere, so the same script reads correctly in both places.
set -uo pipefail

mode=""
expect_notarized=0
bundle=""

while [ $# -gt 0 ]; do
  case "$1" in
    --require-signed)   mode=require ;;
    --warn-if-unsigned) mode=warn ;;
    --expect-notarized) expect_notarized=1 ;;
    -*) echo "verify-macos-signing.sh: unknown option $1" >&2; exit 2 ;;
    *)  bundle="$1" ;;
  esac
  shift
done

# No default for `mode` on purpose. It decides whether an unsigned bundle stops
# a release, and a caller that forgot to say should be told, not guessed at.
[ -n "$mode" ]   || { echo "verify-macos-signing.sh: pass --require-signed or --warn-if-unsigned" >&2; exit 2; }
[ -n "$bundle" ] || { echo "verify-macos-signing.sh: no bundle given" >&2; exit 2; }

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  err()  { echo "::error::$1"; }
  warn() { echo "::warning::$1"; }
else
  err()  { echo "error: $1" >&2; }
  warn() { echo "warning: $1" >&2; }
fi

if [ ! -d "$bundle" ]; then
  err "no bundle at $bundle - the build produced nothing to verify"
  exit 1
fi

echo "==> verifying $bundle"
info="$(codesign -dv --verbose=4 "$bundle" 2>&1)"
echo "$info" | sed 's/^/    /'

# "Unsigned" here means ad-hoc: a Tauri bundle is always linker-signed, never
# bare, so `Signature=adhoc` is what an absent certificate actually looks like.
adhoc=0
case "$info" in *"Signature=adhoc"*) adhoc=1 ;; esac

if [ "$mode" = warn ] && [ "$adhoc" = 1 ]; then
  warn "$bundle is UNSIGNED (ad-hoc). macOS will ask for the keychain password once per launch to unlock the credential vault, and Gatekeeper will refuse the app on download."
  exit 0
fi

fail=0

if [ "$adhoc" = 1 ]; then
  err "$bundle is ad-hoc signed although signing was configured - the identity was not applied"
  fail=1
fi

case "$info" in
  *"TeamIdentifier=not set"*)
    err "$bundle carries no TeamIdentifier - this is not a Developer ID signature"
    fail=1 ;;
esac

case "$info" in
  *"flags="*"runtime"*) ;;
  *)
    err "$bundle is missing the hardened-runtime flag - entitlements.plist will not apply"
    fail=1 ;;
esac

echo
echo "==> entitlements"
codesign -d --entitlements :- "$bundle" 2>/dev/null | sed 's/^/    /'

echo
echo "==> Gatekeeper"
if spctl -a -vvv -t exec "$bundle" 2>&1 | sed 's/^/    /'; then
  :
elif [ "$expect_notarized" = 1 ]; then
  err "Gatekeeper rejected $bundle, which was supposed to be notarized"
  fail=1
else
  # Not a signing failure, and saying so matters: this rejection is the single
  # most likely thing to be misread as "the certificate did not work".
  echo "    (expected: signed but not notarized. Notarization is what fixes this,"
  echo "     and it is NOT what causes the keychain prompts.)"
fi

# Deliberately not run without --expect-notarized: an un-notarized bundle has no
# ticket to staple, and reporting that as a finding would bury the one line that
# matters in noise every fork build produces.
if [ "$expect_notarized" = 1 ]; then
  echo
  echo "==> stapled ticket"
  if staple="$(xcrun stapler validate "$bundle" 2>&1)"; then
    echo "$staple" | sed 's/^/    /'
  else
    echo "$staple" | sed 's/^/    /'
    err "$bundle carries no stapled notarization ticket. Gatekeeper accepted it here only by looking the ticket up online - on a user's machine that is offline or behind a proxy this bundle is REFUSED."
    fail=1
  fi
fi

exit "$fail"
