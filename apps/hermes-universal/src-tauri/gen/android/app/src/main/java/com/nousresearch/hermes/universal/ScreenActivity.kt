package com.nousresearch.hermes.universal

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

// Native screen activity (MJX-141). Hosts every windowable surface — Settings,
// Command Center, Profiles — in ONE Activity; the surface is chosen by the route
// the WebView loads (`?win=activity#<route>`) and can change in place. Launched
// from Rust `open_screen_window` (label "screen", activity_name "ScreenActivity").
//
// Unlike MainActivity — which forces `handleBackNavigation = false` (hardware back
// exits the app) — this re-enables it, so back walks the in-WebView history and, at
// the root, finishes the activity, returning to MainActivity (the sessions screen).
// The web Home button finishes it explicitly via the `__hermesActivity` bridge
// (Tauri's window.close() does not finish an Android Activity — see HomeBridge).
class ScreenActivity : TauriActivity() {
  override val handleBackNavigation: Boolean = true

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(HomeBridge(this), "__hermesActivity")
  }
}
