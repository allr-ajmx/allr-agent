package com.jaxmatrix.mjx_unofficial_hermes

import android.net.Uri
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

// Native screen activity (MJX-141). Hosts every windowable surface — Settings,
// Command Center, Profiles — in ONE Activity; the surface is chosen by the route
// the WebView loads (`?win=activity#<route>`) and can change in place. Launched
// from Rust `open_screen_window` (label "screen", activity_name "ScreenActivity").
//
// Unlike MainActivity — where TauriActivity's `handleBackNavigation = false` means
// hardware back exits the app — back here walks the in-WebView history and, at the
// root, finishes the activity, returning to MainActivity (the sessions screen). The
// web Home button finishes it explicitly via the `__hermesActivity` bridge (Tauri's
// window.close() does not finish an Android Activity — see HomeBridge).
//
// That handler is installed HERE rather than taken from WryActivity (which is why
// `handleBackNavigation` stays false below), because WryActivity's version — plain
// `canGoBack()` / `goBack()` — is wrong for this Activity once a sign-in has run.
//
// Android cannot open a second webview window, so a gateway or Hermes Cloud sign-in
// started from Settings navigates THIS WebView to the provider's login page and then
// back to the app (`src-tauri/src/oauth.rs`, `src-tauri/src/cloud.rs`). Both legs go
// through `loadUrl`, so both PUSH history: after one sign-in the back-forward list
// reads `[app #/settings] [gateway /auth/login] [IDP …] [gateway dashboard] [app
// #/settings]`. `goBack()` from the Settings screen the user lands back on therefore
// walks them BACKWARDS into the gateway's own web dashboard, rendered full-bleed
// inside the Settings activity with no app chrome — and every further back press
// goes one redirect deeper into the login cascade instead of out of it.
//
// So the rule is: go back only while the previous entry shares an origin with the
// current one, and finish the Activity at any origin boundary. In-app hash routes
// all share the app origin and still walk normally; the login cascade is walkable
// while you are inside it; and crossing out of the app — or back into a login that
// has already completed — leaves the screen instead, which is what back means here.
class ScreenActivity : TauriActivity() {
  override val handleBackNavigation: Boolean = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(HomeBridge(this), "__hermesActivity")
    onBackPressedDispatcher.addCallback(this, BackWithinOneOrigin(webView))
  }

  private inner class BackWithinOneOrigin(private val webView: WebView) :
    OnBackPressedCallback(true) {
    override fun handleOnBackPressed() {
      if (previousEntryIsSameOrigin()) {
        webView.goBack()
      } else {
        // The root of the screen, or the far side of a sign-in round-trip: drop the
        // whole activity rather than re-entering a document the user already left.
        finish()
      }
    }

    private fun previousEntryIsSameOrigin(): Boolean {
      if (!webView.canGoBack()) {
        return false
      }

      val history = webView.copyBackForwardList()
      val index = history.currentIndex

      if (index <= 0) {
        return false
      }

      val here = history.getItemAtIndex(index)?.url ?: return false
      val previous = history.getItemAtIndex(index - 1)?.url ?: return false

      return sameOrigin(here, previous)
    }
  }

  // Scheme + authority, the same pair a web origin is made of. Deliberately not a
  // comparison against a hardcoded app origin: that origin is the Vite dev server in
  // development and http://tauri.localhost in a release build, and this must behave
  // the same in both.
  private fun sameOrigin(here: String, previous: String): Boolean {
    val left = Uri.parse(here)
    val right = Uri.parse(previous)

    return left.scheme == right.scheme && left.authority == right.authority
  }
}
