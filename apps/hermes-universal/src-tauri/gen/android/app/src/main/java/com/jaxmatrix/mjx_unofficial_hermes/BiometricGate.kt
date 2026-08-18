package com.jaxmatrix.mjx_unofficial_hermes

import android.os.Build
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The device-unlock gate, Android half. Called from Rust over JNI —
 * see `src/secrets/gate.rs`.
 *
 * BiometricPrompt has two hard requirements that shape everything here: it needs
 * a FragmentActivity (WryActivity extends AppCompatActivity, so our activities
 * qualify), and `authenticate` must be called on the UI thread. Rust calls in
 * from a blocking pool thread, so the prompt is posted to the UI thread and the
 * caller waits on a latch — which is safe precisely because the calling thread is
 * never the UI one.
 */
object BiometricGate {
    private const val TAG = "BiometricGate"

    /** How long to wait for an answer before giving up on the prompt. */
    private const val TIMEOUT_SECONDS = 120L

    /**
     * The activity to present from.
     *
     * Weakly held in effect by being cleared on destroy: a strong static
     * reference to an Activity that outlives it is a textbook leak, and this one
     * would pin the whole WebView with it.
     */
    @Volatile
    private var current: FragmentActivity? = null

    @JvmStatic
    fun attach(activity: FragmentActivity) {
        current = activity
    }

    @JvmStatic
    fun detach(activity: FragmentActivity) {
        // Identity check: ScreenActivity being destroyed must not clear the
        // reference MainActivity just installed.
        if (current === activity) {
            current = null
        }
    }

    /**
     * Which authenticators to ask for.
     *
     * BIOMETRIC_STRONG combined with DEVICE_CREDENTIAL is documented as
     * unsupported on API 28 and 29 — asking for it there throws rather than
     * degrading. minSdk is 24, so the combination is gated on R and below that we
     * ask for the device credential alone, which every device with a lock screen
     * has. The point is to establish the owner is present, and a PIN answers that
     * as well as a fingerprint.
     */
    private fun authenticators(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        }

    /**
     * Whether this device can authenticate its owner at all.
     *
     * False when no lock screen is set. That is a real state, not an error: the
     * Rust side treats it as "this device cannot hold credentials safely" rather
     * than as a failure to report.
     */
    @JvmStatic
    fun canAuthenticate(): Boolean {
        val activity = current ?: return false

        return try {
            BiometricManager.from(activity).canAuthenticate(authenticators()) ==
                BiometricManager.BIOMETRIC_SUCCESS
        } catch (error: Throwable) {
            Log.w(TAG, "could not query biometric availability", error)
            false
        }
    }

    /**
     * Show the prompt and block until it is answered.
     *
     * MUST NOT be called from the UI thread — it would deadlock against the very
     * prompt it is waiting for. Rust only ever calls it from a blocking pool.
     */
    @JvmStatic
    fun authenticate(reason: String): Boolean {
        val activity = current ?: return false
        val latch = CountDownLatch(1)
        val granted = AtomicBoolean(false)

        activity.runOnUiThread {
            try {
                val callback = object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        granted.set(true)
                        latch.countDown()
                    }

                    override fun onAuthenticationError(code: Int, message: CharSequence) {
                        // Cancelled, locked out, or dismissed. All of them mean
                        // "not authenticated", and the Rust side says so without
                        // guessing which.
                        latch.countDown()
                    }

                    // Deliberately NOT counting down: a rejected fingerprint is a
                    // retry, and the prompt stays up for another attempt. Only an
                    // error or a success ends the exchange.
                    override fun onAuthenticationFailed() = Unit
                }

                val info = BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Unlock Hermes")
                    .setSubtitle(reason)
                    .setAllowedAuthenticators(authenticators())
                    .build()

                BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
                    .authenticate(info)
            } catch (error: Throwable) {
                Log.e(TAG, "could not present the unlock prompt", error)
                latch.countDown()
            }
        }

        return try {
            // A prompt nobody answers must not hold the caller — or the SSH
            // connect behind it — open indefinitely.
            latch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS) && granted.get()
        } catch (interrupted: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
    }
}
