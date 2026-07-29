package com.nousresearch.hermes.universal

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

// Native activity screen (MJX-141). Hosts the Command Center ("System panel")
// WebView opened from Rust (`open_system_window` builds a WebviewWindow labelled
// `command-center` at `?win=activity&screen=command-center`). Re-enables back
// navigation (see SettingsActivity) so back walks the in-WebView section history
// and, at the root, finishes the activity → returns to MainActivity. The web Home
// button finishes it explicitly via the `__hermesActivity` bridge (HomeBridge).
class SystemActivity : TauriActivity() {
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
