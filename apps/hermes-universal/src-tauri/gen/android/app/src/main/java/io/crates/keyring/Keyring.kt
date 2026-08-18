package io.crates.keyring

import android.content.Context

/**
 * Kotlin binding for android-native-keyring-store's ndk-context initializer.
 *
 * The package, class and method names are load-bearing: the native implementation
 * is exported from the app's main Rust `.so` as
 * `Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext`, so this
 * must stay `io.crates.keyring.Keyring.Companion.initializeNdkContext`. No
 * `System.loadLibrary` is needed — the symbol lives in the app library the Tauri
 * activity has already loaded.
 *
 * Previously this lived inside a vendored Tauri plugin. That plugin is gone (it
 * shipped with no license — see src/secrets/store.rs), and the crate it binds to
 * is MIT/Apache-2.0, so the binding lives with the app now.
 */
class Keyring {
    companion object {
        external fun initializeNdkContext(context: Context)
    }
}
