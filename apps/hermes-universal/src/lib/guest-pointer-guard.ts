/**
 * An `<iframe>` hit-tests on its own, so a pointer-capture drag in the embedder
 * can go silent the moment the cursor crosses one: the sash resize froze a few
 * pixels into an artifact preview and only another press could continue it, and
 * a tab dragged over one lost its drop hints. While a drag is live, make every
 * guest surface transparent to hit-testing (the `guest-pointer-lock` rule in
 * styles.css) so the window-level pointermove / pointerup listeners keep
 * receiving the gesture.
 *
 * Universal's guests are real iframes — the artifact preview inside a preview
 * tile, and the transcript's video / social / map embeds — not Electron
 * `<webview>` elements, which do not exist here. That is a narrower selector
 * than desktop's and the same failure: WebKitGTK routes pointer input into a
 * frame the same way Chromium does.
 */
let depth = 0

/** Suppress pointer events on iframe guests until released. Depth-counted so
 *  overlapping gestures compose; the returned release is idempotent (drags end
 *  through several racing paths — pointerup, pointercancel, window blur,
 *  lostpointercapture). */
export function guardGuestPointers(): () => void {
  if (depth === 0) {
    document.body.classList.add('guest-pointer-lock')
  }

  depth += 1
  let released = false

  return () => {
    if (released) {
      return
    }

    released = true
    depth -= 1

    if (depth === 0) {
      document.body.classList.remove('guest-pointer-lock')
    }
  }
}
