package com.nousresearch.hermes.universal

import android.app.Activity
import android.webkit.JavascriptInterface

// JS ⇄ native bridge for the activity screens (MJX-141). Tauri's
// `WebviewWindow.close()` does NOT finish an Android Activity (it only drops the
// Rust-side window handle) and `set_focus` is a no-op on Android, so the web
// Home button cannot return to MainActivity through Tauri. This exposes
// `window.__hermesActivity.finish()`, which finishes the hosting Activity —
// exactly what the hardware back button does — dropping back to MainActivity
// (where the sessions live). Added via `WebView.addJavascriptInterface(…,
// "__hermesActivity")` in each activity's `onWebViewCreate`.
class HomeBridge(private val activity: Activity) {
  @JavascriptInterface
  fun finish() {
    activity.runOnUiThread { activity.finish() }
  }
}
