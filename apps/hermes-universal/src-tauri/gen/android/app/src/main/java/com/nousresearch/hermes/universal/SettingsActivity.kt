package com.nousresearch.hermes.universal

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

// Native activity screen (MJX-141). Hosts the Settings WebView opened from Rust
// (`open_settings_window` builds a WebviewWindow labelled `settings` at
// `?win=activity&screen=settings`). Unlike MainActivity — which forces
// `handleBackNavigation = false` (hardware back exits the app) — this re-enables
// it, so back walks the in-WebView history (settings sub-pages) and, at the
// history root, finishes the activity, returning to MainActivity. The web Home
// button finishes it explicitly via the `__hermesActivity` bridge (Tauri's
// window.close() does not finish an Android Activity — see HomeBridge).
class SettingsActivity : TauriActivity() {
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
