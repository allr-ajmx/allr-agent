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

/// Serializes tests that touch the lease.
///
/// The lease is process-wide state, and Rust runs tests in parallel — one test
/// calling `lock()` while another is mid-read makes both of them flaky in a way
/// that looks like a real bug in the gate.
#[cfg(test)]
pub static TEST_LOCK: Mutex<()> = Mutex::new(());

/// Take {@link TEST_LOCK}, surviving a poisoned mutex from an earlier failure.
#[cfg(test)]
pub fn test_guard() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Open a lease without prompting.
///
/// Test seam. Storage tests are about storage, and whether they need a lease at
/// all would otherwise depend on whether the machine running them has a passcode
/// set — which is exactly the kind of environment-dependent flake that is
/// miserable to chase down later.
#[cfg(test)]
pub fn grant_for_test() {
    grant();
}

/// End it now.
///
/// Called on background/suspend as well as on an explicit lock: the whole point
/// of a short lease is that walking away closes it, and "backgrounded" is the
/// closest signal we get to that on a phone.
pub fn lock() {
    *lease() = None;
}

/// The Kotlin class that presents the Android unlock prompt.
///
/// Built from the package name the Tauri build script exports rather than
/// hardcoded, so renaming the app cannot silently turn this into a runtime
/// "class not found" that only shows up on a device. Lives here, outside the
/// `cfg(target_os = "android")` module, purely so it stays testable on a host
/// that has no Android NDK to cross-compile with.
#[allow(dead_code)]
fn android_gate_class() -> String {
    let prefix = env!("TAURI_ANDROID_PACKAGE_NAME_PREFIX").replace('_', "/");
    let app = env!("TAURI_ANDROID_PACKAGE_NAME_APP_NAME");

    format!("{prefix}/{app}/BiometricGate")
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
    use std::collections::HashMap;

    use zbus::zvariant::Value;

    use super::SecretsError;

    /// The action declared in `polkit/com.jaxmatrix.hermes.policy`, which the
    /// .deb installs to `/usr/share/polkit-1/actions/`.
    const ACTION: &str = "com.jaxmatrix.hermes.unlock-credentials";

    const SERVICE: &str = "org.freedesktop.PolicyKit1";
    const PATH: &str = "/org/freedesktop/PolicyKit1/Authority";
    const INTERFACE: &str = "org.freedesktop.PolicyKit1.Authority";

    /// `AllowUserInteraction` — without it polkit answers from cached state and
    /// never puts a dialog up, which would make the gate a no-op.
    const ALLOW_INTERACTION: u32 = 1;

    fn connect() -> Option<zbus::blocking::Connection> {
        zbus::blocking::Connection::system().ok()
    }

    /// Whether polkit knows about our action.
    ///
    /// The policy file only exists on a packaged install: an AppImage, a tarball
    /// or `cargo run` has nowhere to put it. Rather than pretend, this reports
    /// no gate there, and the caller leaves storage ungated exactly as it was —
    /// far better than refusing to persist credentials on the strength of a file
    /// the user never had a chance to install.
    fn action_registered(connection: &zbus::blocking::Connection) -> bool {
        // Each entry is (action_id, description, message, vendor, vendor_url,
        // icon_name, implicit_any, implicit_inactive, implicit_active, annotations).
        // Only the first field matters here.
        type Action = (
            String,
            String,
            String,
            String,
            String,
            String,
            u32,
            u32,
            u32,
            HashMap<String, String>,
        );

        let Ok(reply) = connection.call_method(
            Some(SERVICE),
            PATH,
            Some(INTERFACE),
            "EnumerateActions",
            &(""),
        ) else {
            return false;
        };

        reply
            .body()
            .deserialize::<Vec<Action>>()
            .map(|actions| actions.iter().any(|action| action.0 == ACTION))
            .unwrap_or(false)
    }

    /// Ask polkit whether this process may unlock, optionally letting it prompt.
    fn check(connection: &zbus::blocking::Connection, flags: u32) -> bool {
        // `system-bus-name` rather than `unix-process`: polkit resolves the
        // caller from our own connection, so there is no pid/start-time pair to
        // assemble and no window in which a recycled pid could be mistaken for
        // us.
        let Some(unique) = connection.unique_name().map(|name| name.to_string()) else {
            return false;
        };

        let mut subject_details: HashMap<&str, Value> = HashMap::new();
        subject_details.insert("name", Value::from(unique));

        let subject = ("system-bus-name", subject_details);
        let details: HashMap<&str, &str> = HashMap::new();

        let Ok(reply) = connection.call_method(
            Some(SERVICE),
            PATH,
            Some(INTERFACE),
            "CheckAuthorization",
            &(subject, ACTION, details, flags, ""),
        ) else {
            return false;
        };

        // (is_authorized, is_challenge, details)
        reply
            .body()
            .deserialize::<(bool, bool, HashMap<String, String>)>()
            .map(|(authorized, _, _)| authorized)
            .unwrap_or(false)
    }

    pub fn available() -> bool {
        connect().is_some_and(|connection| action_registered(&connection))
    }

    pub fn prompt(_reason: &str) -> Result<(), SecretsError> {
        // The wording the user sees comes from the policy file's <message>, not
        // from here — polkit owns the dialog, and it localizes that text.
        let Some(connection) = connect() else {
            return Err(SecretsError::unavailable("polkit is not reachable"));
        };

        if check(&connection, ALLOW_INTERACTION) {
            Ok(())
        } else {
            Err(SecretsError::locked("the unlock was refused"))
        }
    }
}

// --------------------------------------------------------------------------
// Android — BiometricPrompt. UNVERIFIED: not compiled.
// --------------------------------------------------------------------------

#[cfg(target_os = "android")]
mod imp {
    use jni::objects::{JObject, JValue};
    use jni::JavaVM;

    use super::SecretsError;

    // The Kotlin half. BiometricPrompt must run on the UI thread and needs a
    // FragmentActivity, so the prompt itself lives there and this only drives it
    // — see `gen/android/.../BiometricGate.kt`.
    use super::android_gate_class;

    /// Call a no-argument-or-string static method that answers with a boolean.
    ///
    /// Everything is funnelled through here so a missing class or a changed
    /// signature surfaces as `false` rather than as an exception left pending on
    /// the thread — a pending JNI exception poisons every later call on it, so it
    /// is cleared explicitly.
    fn call_bool(method: &str, reason: Option<&str>) -> bool {
        let context = ndk_context::android_context();

        let Ok(vm) = (unsafe { JavaVM::from_raw(context.vm().cast()) }) else {
            return false;
        };

        let Ok(mut env) = vm.attach_current_thread() else {
            return false;
        };

        let outcome = (|| -> Result<bool, jni::errors::Error> {
            let class = env.find_class(android_gate_class())?;

            let value = match reason {
                Some(reason) => {
                    let arg = env.new_string(reason)?;

                    env.call_static_method(
                        class,
                        method,
                        "(Ljava/lang/String;)Z",
                        &[JValue::Object(&JObject::from(arg))],
                    )?
                }

                None => env.call_static_method(class, method, "()Z", &[])?,
            };

            value.z()
        })();

        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_describe();
            let _ = env.exception_clear();

            return false;
        }

        outcome.unwrap_or(false)
    }

    /// False when no lock screen is set, which is a real state rather than a
    /// failure: a device with no lock cannot hold credentials safely, and the
    /// caller treats that as a reason not to persist them.
    pub fn available() -> bool {
        call_bool("canAuthenticate", None)
    }

    pub fn prompt(reason: &str) -> Result<(), SecretsError> {
        // Blocks on the Kotlin side until the prompt is answered. Safe only
        // because `gate::unlock` calls this from a blocking pool thread and never
        // from the UI thread, which would deadlock against the prompt.
        if call_bool("authenticate", Some(reason)) {
            Ok(())
        } else {
            Err(SecretsError::locked("the unlock was refused"))
        }
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
        let _guard = test_guard();

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
        let _guard = test_guard();

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
    fn the_android_gate_class_resolves_to_the_kotlin_one() {
        // This machine has no NDK, so the Android arm cannot be cross-compiled
        // and a wrong class path would only surface on a device, as a JNI
        // lookup that fails and takes the whole gate with it. The package name
        // comes from the Tauri build script, which exports it on every target.
        assert_eq!(
            android_gate_class(),
            "com/jaxmatrix/mjx_unofficial_hermes/BiometricGate",
            "must match the package of gen/android/.../BiometricGate.kt"
        );
    }

    #[test]
    fn the_lease_matches_what_the_android_keystore_can_enforce() {
        // setUserAuthenticationParameters takes whole seconds; a mismatch here
        // would put the app-side window and the OS-side one out of step.
        assert_eq!(LEASE, Duration::from_secs(300));
    }
}
