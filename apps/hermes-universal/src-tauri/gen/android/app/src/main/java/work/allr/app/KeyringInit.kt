package work.allr.app

import android.content.Context
import android.util.Log
import io.crates.keyring.Keyring

/**
 * Hand the Android Context to the native credential store, once per process.
 *
 * `android-native-keyring-store` reads its Context and JavaVM out of the global
 * `ndk_context` crate. Tauri and wry do NOT populate it — nothing else in the
 * tree depends on `ndk_context` — so without this the first Keystore call reads
 * an uninitialized context and aborts the process rather than returning an error.
 *
 * Called from every activity's `onCreate`, after `super`, so the native library
 * is loaded and it does not matter which activity the user arrives through. The
 * Rust side creates the store lazily on first use (`secrets::store::ensure`), by
 * which point this has run.
 */
object KeyringInit {
    private var done = false

    @Synchronized
    fun ensure(context: Context) {
        if (done) {
            return
        }

        try {
            // Application context, not the activity: the store outlives any one
            // activity, and holding an activity here would leak it.
            Keyring.initializeNdkContext(context.applicationContext)
            done = true
        } catch (error: Throwable) {
            // Left un-done so a later activity retries. Storage then reports
            // itself unavailable, which is the honest answer — far better than
            // taking the whole app down over the keychain.
            Log.e("KeyringInit", "could not initialize the native keyring context", error)
        }
    }
}
