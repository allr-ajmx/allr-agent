package com.jaxmatrix.mjx_unofficial_hermes

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // After super: the native library must be loaded before the JNI
    // symbol this resolves exists. See KeyringInit.
    KeyringInit.ensure(this)
    // The unlock prompt needs a FragmentActivity to present from.
    BiometricGate.attach(this)
  }

  // Clearing the static reference here is what keeps it from outliving the
  // activity and pinning the WebView with it.
  override fun onDestroy() {
    BiometricGate.detach(this)
    super.onDestroy()
  }
}
