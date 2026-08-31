#!/usr/bin/env bash
#
# Launch a built Linux bundle on a throwaway X server and prove it actually put
# a rendered UI on screen.
#
# Why this exists: release-desktop.yml used to build, upload and publish without
# ever LAUNCHING what it built, and desktop-v0.0.7 shipped an AppImage whose
# WebKit web process could not start. The bundle ran, the window mapped, and
# nothing rendered -- a failure that is invisible to every check that stops at
# "the process is still alive".
#
# So there are three assertions, and the third is the load-bearing one. It is
# not hypothetical: run against the released Allr_0.0.7_amd64.AppImage this
# script reports 2 distinct colours, and against the same payload linked to the
# host's WebKitGTK it reports 1315.
#
# The three:
#
#   1. the process survives the grace period      (catches a crash on boot)
#   2. a top-level window is mapped               (catches a window that never opens)
#   3. the screen is not a flat colour            (catches a window that never PAINTS)
#
# (3) is what an unpainted webview looks like: a correctly sized, correctly
# placed, entirely blank rectangle. ImageMagick's `%k` is the count of distinct
# colours in the frame; a real UI has hundreds, a blank one has single digits.
#
# usage: smoke-test-linux-bundle.sh <executable> [label]

set -euo pipefail

exe="${1:?usage: smoke-test-linux-bundle.sh <executable> [label]}"
label="${2:-$(basename "$exe")}"

# Long enough for a cold WebKit start on a loaded runner, short enough that a
# hung leg does not eat the 90-minute budget.
readonly BOOT_GRACE_SECONDS=45
# Separate budget for first paint, POLLED rather than slept: under Xvfb's
# software rendering a cold WebKit takes an unpredictable few seconds, and a
# fixed sleep would either be flaky or waste a minute on every green run.
readonly PAINT_GRACE_SECONDS=45
# A flat frame is 1-3 colours (background, maybe a border). A rendered UI clears
# this by two orders of magnitude, so the threshold does not need to be tuned.
readonly MIN_DISTINCT_COLOURS=32

fail() {
  echo "::error::[$label] $1"
  exit 1
}

log() { echo "[$label] $1"; }

shot_dir="${SMOKE_SHOT_DIR:-$PWD/smoke-shots}"
mkdir -p "$shot_dir"
shot="$shot_dir/${label//[^A-Za-z0-9._-]/_}.png"
stderr_log="$shot_dir/${label//[^A-Za-z0-9._-]/_}.log"

[ -x "$exe" ] || fail "not executable: $exe"

log "launching $exe"

# Everything runs INSIDE one xvfb-run so the app and the tools that inspect it
# share a display. xvfb-run's exit status is the inner command's.
set +e
xvfb-run -a --server-args="-screen 0 1600x1200x24" bash -euo pipefail -c '
  exe="$1"; grace="$2"; shot="$3"; stderr_log="$4"; min_colours="$5"; paint_grace="$6"

  # Pin the app to the throwaway X server. Without this, a developer running
  # this on a Wayland desktop hands GTK an inherited WAYLAND_DISPLAY, the app
  # opens a real window on their real screen, and the harness -- looking at
  # Xvfb -- reports "no window was ever mapped" for a build that is fine.
  unset WAYLAND_DISPLAY
  export GDK_BACKEND=x11

  # Xvfb has no GPU. These are properties of the HARNESS, not workarounds
  # smuggled into the app: they make software rendering possible at all, and
  # they are deliberately NOT the variables the app sets for itself
  # (WEBKIT_EXEC_PATH, WEBKIT_DISABLE_DMABUF_RENDERER) -- those must be proven
  # by the binary, not supplied around it.
  export LIBGL_ALWAYS_SOFTWARE=1
  export GALLIUM_DRIVER=llvmpipe
  export WEBKIT_DISABLE_COMPOSITING_MODE=1

  "$exe" >"$stderr_log" 2>&1 &
  pid=$!

  # 1. alive?
  for _ in $(seq 1 "$grace"); do
    kill -0 "$pid" 2>/dev/null || {
      echo "PROCESS_DIED"
      exit 10
    }
    # 2. a mapped top-level window?
    if xdotool search --onlyvisible --name . >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  kill -0 "$pid" 2>/dev/null || { echo "PROCESS_DIED"; exit 10; }
  xdotool search --onlyvisible --name . >/dev/null 2>&1 || { echo "NO_WINDOW"; exit 11; }

  # 3. did anything actually render? Polled, and the LAST frame is the one kept
  # either way -- on a failure that frame is the entire diagnostic.
  colours=0
  for _ in $(seq 1 "$paint_grace"); do
    kill -0 "$pid" 2>/dev/null || { echo "PROCESS_DIED"; exit 10; }
    import -window root "$shot" 2>/dev/null || { sleep 1; continue; }
    colours="$(identify -format "%k" "$shot" 2>/dev/null || echo 0)"
    [ "$colours" -ge "$min_colours" ] && break
    sleep 1
  done
  echo "DISTINCT_COLOURS=$colours"

  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true

  [ "$colours" -ge "$min_colours" ] || exit 12
' _ "$exe" "$BOOT_GRACE_SECONDS" "$shot" "$stderr_log" "$MIN_DISTINCT_COLOURS" "$PAINT_GRACE_SECONDS"
status=$?
set -e

# The app's own output is the only diagnostic a maintainer gets for a failure
# that reproduces on no developer machine, so print it either way.
if [ -s "$stderr_log" ]; then
  log "--- app output ---"
  tail -n 60 "$stderr_log"
  log "--- end app output ---"
fi

case "$status" in
  0)  log "ok - window mapped and painted" ;;
  10) fail "the process exited during the ${BOOT_GRACE_SECONDS}s boot grace period" ;;
  11) fail "no window was ever mapped within ${BOOT_GRACE_SECONDS}s" ;;
  12) fail "a window opened but never painted within ${PAINT_GRACE_SECONDS}s (fewer than ${MIN_DISTINCT_COLOURS} distinct colours on screen) - the app output above is the place to look, and the frame is at $shot" ;;
  *)  fail "smoke test failed with status $status" ;;
esac
