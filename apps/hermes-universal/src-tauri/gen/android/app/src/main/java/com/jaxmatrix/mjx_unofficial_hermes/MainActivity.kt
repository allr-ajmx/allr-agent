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
  }
}
