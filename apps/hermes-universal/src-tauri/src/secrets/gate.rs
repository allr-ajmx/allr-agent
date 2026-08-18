//! The device-unlock gate.
//!
//! Reading a stored credential should require the person at the keyboard to
//! prove they are the device's owner — Touch ID / Face ID, Windows Hello, or the
//! OS passcode as fallback. This module is the mechanism; `mod.rs` decides when
//! to apply it.
//!
//! **One unlock opens a window, it does not authorize one read.** A single SSH
//! connect reads the PEM, the passphrase and the password, so a per-read prompt
//! would fire three biometric dialogs for one action. The lease is
//! [`LEASE`] long and is dropped the moment the app is backgrounded or
//! suspended, so an unattended device does not sit unlocked.
//!
//! Two tiers of enforcement, and the difference is worth stating plainly rather
//! than implying uniformity:
//!
//! * **OS-enforced** — Apple and Android can bind the stored item itself to
//!   authentication (`kSecAccessControl`, a Keystore key with
//!   `setUserAuthenticationRequired`). There, bypassing this module does not get
//!   you the plaintext.
//! * **App-enforced** — Windows Credential Manager and the Linux Secret Service
//!   have no per-item auth binding. The store is already user-bound (DPAPI, the
//!   login keyring), and the consent check happens here, at the boundary. That is
//!   a weaker claim and should be documented as one.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::error::SecretsError;

/// How long one unlock lasts.
///
/// Matches the value Android's Keystore can enforce natively
/// (`setUserAuthenticationParameters(300, …)`), so the app-side lease and the
/// OS-side one agree by construction rather than by coincidence.
pub const LEASE: Duration = Duration::from_secs(5 * 60);

/// When the current lease expires, if there is one.
static UNLOCKED_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

fn lease() -> std::sync::MutexGuard<'static, Option<Instant>> {
    UNLOCKED_UNTIL
        .lock()
        // A panic elsewhere says nothing about whether the user authenticated.
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether a credential may be read right now without asking again.
pub fn is_unlocked() -> bool {
    let mut held = lease();

    match *held {
        Some(until) if Instant::now() < until => true,
        Some(_) => {
            // Expired. Clear it here so a later `status` call does not have to.
            *held = None;

            false
        }
        None => false,
    }
}

/// Start the lease.
fn grant() {
    *lease() = Some(Instant::now() + LEASE);
}

/// End it now.
///
/// Called on background/suspend as well as on an explicit lock: the whole point
/// of a short lease is that walking away closes it, and "backgrounded" is the
/// closest signal we get to that on a phone.
pub fn lock() {
    *lease() = None;
}

/// Whether this device can ask the user to prove who they are at all.
///
/// False on a machine with no biometric and no passcode enrolled, and on any
/// platform whose gate is not implemented. Callers must treat it as a fact about
/// the device, not a failure.
pub fn available() -> bool {
    imp::available()
}

/// Ask the user to prove themselves, then open a lease.
///
/// Already-unlocked is a no-op rather than a second prompt — the lease is the
/// unit of authorization, and re-prompting inside it would defeat the reason it
/// exists.
pub async fn unlock(reason: String) -> Result<(), SecretsError> {
    if is_unlocked() {
        return Ok(());
    }

    if !available() {
        return Err(SecretsError::unavailable(
            "this device has no unlock method set up",
        ));
    }

    // The platform calls all block while a dialog is on screen. Never on an
    // async worker.
    tauri::async_runtime::spawn_blocking(move || imp::prompt(&reason))
        .await
        .map_err(|e| {
            SecretsError::store_failed(format!("the unlock task did not finish: {e}"))
        })??;

    grant();

    Ok(())
}

// --------------------------------------------------------------------------
// Apple — LocalAuthentication. VERIFIED: builds and runs on macOS.
// --------------------------------------------------------------------------

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2::AnyThread;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};

    use super::SecretsError;

    /// Biometry with a passcode fallback, rather than biometry alone.
    ///
    /// `DeviceOwnerAuthenticationWithBiometrics` would refuse outright on a Mac
    /// with no Touch ID, and lock out entirely after three failed scans. The
    /// question we are asking is "is this the device's owner", and the passcode
    /// answers it just as well.
    const POLICY: LAPolicy = LAPolicy::DeviceOwnerAuthentication;

    /// A dialog nobody answers must not hold the caller forever.
    const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

    fn context() -> Retained<LAContext> {
        unsafe { LAContext::init(LAContext::alloc()) }
    }

    pub fn available() -> bool {
        unsafe { context().canEvaluatePolicy_error(POLICY).is_ok() }
    }

    pub fn prompt(reason: &str) -> Result<(), SecretsError> {
        let context = context();
        let reason = NSString::from_str(reason);
        let (tx, rx) = mpsc::channel::<Result<(), String>>();

        // The reply lands on a private queue, so the result comes back over a
        // channel rather than by mutating anything the caller can see.
        let reply = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let outcome = if granted.as_bool() {
                Ok(())
            } else if error.is_null() {
                Err("the unlock was refused".to_string())
            } else {
                Err(unsafe { (*error).localizedDescription() }.to_string())
            };

            // The receiver is gone only if we already timed out.
            let _ = tx.send(outcome);
        });

        unsafe { context.evaluatePolicy_localizedReason_reply(POLICY, &reason, &reply) };

        match rx.recv_timeout(PROMPT_TIMEOUT) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => Err(SecretsError::locked(message)),
            Err(_) => Err(SecretsError::locked("the unlock prompt went unanswered")),
        }
    }
}

// --------------------------------------------------------------------------
// Windows — Windows Hello via UserConsentVerifier. UNVERIFIED: not compiled.
// --------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod imp {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };

    use super::SecretsError;

    pub fn available() -> bool {
        matches!(
            UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.get()),
            Ok(UserConsentVerifierAvailability::Available)
        )
    }

    pub fn prompt(reason: &str) -> Result<(), SecretsError> {
        // NOTE: `RequestVerificationAsync` is a WinRT API that a packaged (UWP)
        // app can call directly. A Win32 process — which this is — is documented
        // to need `IUserConsentVerifierInterop::RequestVerificationForWindowAsync`
        // with an HWND, or the call fails with "invalid window handle". If that
        // turns out to be the case here, thread the main window's HWND through
        // rather than dropping the gate; the shape below stays the same.
        let result = UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(reason))
            .and_then(|op| op.get())
            .map_err(|e| SecretsError::locked(format!("Windows Hello could not run: {e}")))?;

        match result {
            UserConsentVerificationResult::Verified => Ok(()),
            UserConsentVerificationResult::Canceled => {
                Err(SecretsError::locked("the unlock was cancelled"))
            }
            _ => Err(SecretsError::locked("the unlock was refused")),
        }
    }
}

// --------------------------------------------------------------------------
// Linux — polkit. UNVERIFIED: not compiled.
// --------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod imp {
    use super::SecretsError;

    /// Deliberately false for now, so §3.4's "no gate → do not persist" rule
    /// never fires on Linux while this is unimplemented.
    ///
    /// Linux has no equivalent of Hello or LocalAuthentication. The two real
    /// options, neither of which is a pure code change:
    ///
    /// 1. **polkit** — `org.freedesktop.PolicyKit1.Authority.CheckAuthorization`
    ///    with `AllowUserInteraction`, which prompts for the user's own password.
    ///    `zbus` is already in the tree for it, but it needs an action id
    ///    declared in a `.policy` file installed to
    ///    `/usr/share/polkit-1/actions/`, which only the .deb/.rpm can place — so
    ///    it cannot work from an AppImage or a `cargo run`.
    /// 2. **Locking the Secret Service collection** and letting the unlock prompt
    ///    be the gate. Closer to the platform's own model and needs no packaging,
    ///    but `dbus-secret-service-keyring-store` does not expose lock/unlock, so
    ///    it means talking to the Secret Service directly alongside the store.
    ///
    /// (2) is the better fit. Both are a design decision, not a stub to fill in.
    pub fn available() -> bool {
        false
    }

    pub fn prompt(_reason: &str) -> Result<(), SecretsError> {
        Err(SecretsError::unavailable(
            "no unlock method is available on Linux yet",
        ))
    }
}

// --------------------------------------------------------------------------
// Android — BiometricPrompt. UNVERIFIED: not compiled.
// --------------------------------------------------------------------------

#[cfg(target_os = "android")]
mod imp {
    use super::SecretsError;

    /// Android's gate is the one that also changes how the secret is STORED: the
    /// strong version wraps the credential in an AES-GCM key created with
    /// `setUserAuthenticationRequired(true)` and
    /// `setUserAuthenticationParameters(300, BIOMETRIC_STRONG | DEVICE_CREDENTIAL)`,
    /// so the Keystore itself enforces both the prompt and the 5-minute window.
    ///
    /// That needs a Kotlin `BiometricPrompt` surface (it must run on the UI
    /// thread, attached to a FragmentActivity) plus a JNI bridge, so it is not a
    /// Rust-only change. False until that lands, for the same reason as Linux.
    pub fn available() -> bool {
        false
    }

    pub fn prompt(_reason: &str) -> Result<(), SecretsError> {
        Err(SecretsError::unavailable(
            "no unlock method is available on Android yet",
        ))
    }
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "android"
)))]
mod imp {
    use super::SecretsError;

    pub fn available() -> bool {
        false
    }

    pub fn prompt(_reason: &str) -> Result<(), SecretsError> {
        Err(SecretsError::unavailable(
            "this platform has no unlock method",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lease_expires_rather_than_lasting_the_session() {
        lock();
        assert!(!is_unlocked());

        grant();
        assert!(is_unlocked());

        // Backgrounding the app drops it immediately — the lease is short
        // precisely so that walking away closes it.
        lock();
        assert!(!is_unlocked());
    }

    #[test]
    fn an_elapsed_lease_reads_as_locked() {
        *lease() = Some(Instant::now() - Duration::from_secs(1));
        assert!(!is_unlocked());
        // ...and is cleared, so nothing has to sweep it later.
        assert!(lease().is_none());
    }

    /// Exercises the real Objective-C bindings.
    ///
    /// Worth a test of its own because the failure mode of a hand-written objc2
    /// binding is not a compile error — a wrong selector or a broken thread rule
    /// aborts the process at the call. `canEvaluatePolicy` presents no UI, so
    /// this is safe to run anywhere; the answer itself depends on what the
    /// machine has enrolled, so it is not asserted.
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn the_apple_bindings_survive_being_called() {
        let _ = available();
    }

    #[test]
    fn the_lease_matches_what_the_android_keystore_can_enforce() {
        // setUserAuthenticationParameters takes whole seconds; a mismatch here
        // would put the app-side window and the OS-side one out of step.
        assert_eq!(LEASE, Duration::from_secs(300));
    }
}
