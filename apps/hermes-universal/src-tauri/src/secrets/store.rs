//! The OS credential store, spoken to directly.
//!
//! This replaces a vendored copy of `charlesportwoodii/tauri-plugin-keyring`.
//! Two reasons it is ours now, and both matter:
//!
//! 1. **Licensing.** That repository carries no license file at all, which under
//!    default copyright means no grant to redistribute it — not something to
//!    discover during a release audit. Everything it wrapped (`keyring-core` and
//!    the four `*-native-keyring-store` crates) is MIT/Apache-2.0, so talking to
//!    them directly removes the problem rather than papering over it.
//! 2. **Reach.** Binding a credential to a device unlock needs `kSecAccessControl`
//!    on Apple and a `setUserAuthenticationRequired` Keystore key on Android —
//!    neither of which a generic get/set wrapper can express. Owning this layer
//!    is what makes that possible at all.
//!
//! The entry SHAPE is deliberately byte-identical to what the plugin wrote
//! (`<service>/<account>/password`), so an install that upgrades into this build
//! finds its existing credentials exactly where it left them. Changing that shape
//! silently orphans every stored token, key and password.
//!
//! The service NAME did change once, in the Allr rename, which is why [`read`] falls
//! back to [`LEGACY_SERVICE`] and migrates what it finds. That is the one exception,
//! and it exists because the rename shipped without it and orphaned exactly what this
//! paragraph warns about.

use std::collections::HashSet;
use std::sync::Mutex;

use keyring_core::Entry;

use super::error::SecretsError;

/// The OS credential group everything lives under. One service means one thing
/// for the user to find, inspect and revoke.
pub const SERVICE: &str = "allr";

/// The service builds before the Allr rename wrote under.
///
/// Read-only, and read only when the canonical entry is absent. The rename left two
/// populations in the wild — installs that stored under `hermes`, and installs from
/// the branch that had already moved to `allr` — and this module is the only thing
/// standing between the first of them and a silently empty keyring. The OAuth token
/// sets (`nativeAuth:<gateway>`) live here, so orphaning them does not read as
/// "credentials moved"; it reads as "I signed in and the app forgot".
const LEGACY_SERVICE: &str = "hermes"; // rebrand:keep

/// Whether the process-wide default store has been installed.
///
/// A `Mutex<bool>` rather than a `OnceLock`, because failure must stay
/// retryable. On Android the store cannot be built until `ndk_context` has been
/// populated from the Java side, and caching that one early failure forever
/// would disable credential storage for the whole run.
static READY: Mutex<bool> = Mutex::new(false);

/// Accounts already looked for under [`LEGACY_SERVICE`] and not found there.
///
/// The fallback in [`read`] is a migration path, and a migration ends. For an
/// account that exists under NEITHER service it never does: the canonical read
/// misses, the legacy read misses, nothing is written, and the next read repeats
/// both. That is a permanently doubled round trip for every credential the user
/// has not set — on this codebase's own key list, most of them.
///
/// Doubling matters more than it sounds. On Linux each read is a D-Bus call to
/// another process; on macOS it is an ACL check that, on an ad-hoc signed build,
/// the OS answers with a password dialog.
///
/// Process-local and never persisted. A pre-rename credential cannot appear in a
/// service we have already read while this process runs — nothing else writes
/// there, this module having been the only writer of `hermes` before the rename
/// and no longer writing it at all — and a fresh launch checks again regardless.
static LEGACY_CHECKED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Has `account` already been looked for under the legacy service and missed?
fn legacy_known_absent(account: &str) -> bool {
    LEGACY_CHECKED
        .lock()
        .ok()
        .and_then(|memo| memo.as_ref().map(|seen| seen.contains(account)))
        .unwrap_or(false)
}

/// Record that the legacy service holds nothing for `account`.
fn note_legacy_absent(account: &str) {
    if let Ok(mut memo) = LEGACY_CHECKED.lock() {
        memo.get_or_insert_with(HashSet::new)
            .insert(account.to_string());
    }
}

/// Forget that memo for `account`.
///
/// Called from `write` and `remove` because both make the legacy question fresh
/// again: `remove` clears BOTH services, and a later `write` then `remove` must
/// still leave `read` able to prove the legacy entry is gone rather than assuming
/// it from a memo taken before either ran.
fn clear_legacy_memo(account: &str) {
    if let Ok(mut memo) = LEGACY_CHECKED.lock() {
        if let Some(seen) = memo.as_mut() {
            seen.remove(account);
        }
    }
}

/// Install the platform store, once.
pub fn ensure() -> Result<(), SecretsError> {
    let mut ready = READY
        .lock()
        // A panic in another holder says nothing about the store itself.
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if *ready {
        return Ok(());
    }

    install()?;
    *ready = true;

    Ok(())
}

/// Build the right store for this platform and make it the default.
///
/// There is deliberately no in-memory fallback and no environment-variable
/// escape hatch. The plugin had both, and the escape hatch was read in release
/// builds — so a single env var sent every session token, SSH private key and
/// password to process memory instead of the keychain, reporting success the
/// whole way. "Nothing is being stored" has to be a visible failure.
//
// The explicit `return` in each arm is load-bearing, not stylistic: exactly one
// arm survives `cfg` evaluation, and without it the surviving block's value
// would be a statement with nothing to fall through to.
#[allow(clippy::needless_return)]
fn install() -> Result<(), SecretsError> {
    #[cfg(test)]
    {
        let store = keyring_core::mock::Store::new()
            .map_err(|e| SecretsError::unavailable(format!("mock store: {e}")))?;
        keyring_core::set_default_store(store);

        return Ok(());
    }

    // The two Apple targets take different stores, and the split is load-bearing.
    //
    // The Protected Data keychain writes with `kSecUseDataProtectionKeychain`, which
    // needs the process to carry a keychain access group. That comes from a
    // `keychain-access-groups`/`application-identifier` entitlement, i.e. from a
    // provisioning profile. iOS always has one; a macOS bundle only has one if it is
    // signed with a profile, and this one is not — `entitlements.plist` grants only
    // `com.apple.security.device.audio-input`, Developer ID signing embeds no
    // profile, and `tauri dev` runs a bare binary. Using it there returned
    // `errSecMissingEntitlement (-34018)` on every single write.
    //
    // This paragraph used to argue the point from "no `bundle.macOS` in
    // tauri.conf.json". That section exists now, so the evidence was stale even
    // though the conclusion was not — and it is the kind of comment someone
    // re-checks before switching stores, so it has to be checkable.
    //
    // That failure was invisible from here: `protected::Store::new()` is infallible,
    // so `ensure` succeeded and `secrets_status` advertised a working store while
    // nothing could be written to it. What it looked like from the outside was a
    // desktop sign-in that finished in the browser and left the app signed out —
    // `oauth.rs::store_native_tokens` could not persist the token set.
    #[cfg(all(not(test), target_os = "macos"))]
    {
        // The file-based login keychain. Available to any process, entitlement or not.
        let store = apple_native_keyring_store::keychain::Store::new()
            .map_err(|e| SecretsError::unavailable(format!("the Keychain is unavailable: {e}")))?;
        keyring_core::set_default_store(store);

        return Ok(());
    }

    #[cfg(all(not(test), target_os = "ios"))]
    {
        // The `protected` store is the Protected Data keychain, and is required
        // on iOS — the crate errors without it.
        let store = apple_native_keyring_store::protected::Store::new()
            .map_err(|e| SecretsError::unavailable(format!("the Keychain is unavailable: {e}")))?;
        keyring_core::set_default_store(store);

        return Ok(());
    }

    #[cfg(all(not(test), target_os = "windows"))]
    {
        let store = windows_native_keyring_store::Store::new().map_err(|e| {
            SecretsError::unavailable(format!("Credential Manager is unavailable: {e}"))
        })?;
        keyring_core::set_default_store(store);

        return Ok(());
    }

    #[cfg(all(not(test), target_os = "linux"))]
    {
        // A desktop with no Secret Service provider running (no gnome-keyring,
        // no kwallet) lands here. That is a real "we will not persist
        // credentials" answer, not an error to swallow.
        let store = dbus_secret_service_keyring_store::Store::new().map_err(|e| {
            SecretsError::unavailable(format!(
                "no Secret Service is available on this session: {e}. Credentials will not be \
                 saved. Start a keyring daemon (gnome-keyring or kwallet) and try again."
            ))
        })?;
        keyring_core::set_default_store(store);

        return Ok(());
    }

    #[cfg(all(not(test), target_os = "android"))]
    {
        // Reads the Context/JavaVM out of the global `ndk_context`, which Tauri
        // does NOT populate. MainActivity does, via the crate's own JNI entry
        // point — see `gen/android/.../KeyringInit.kt`. Because this runs lazily
        // on first use, the WebView (and therefore that call) already exists.
        let store = android_native_keyring_store::Store::new().map_err(|e| {
            SecretsError::unavailable(format!("the Android Keystore is unavailable: {e}"))
        })?;
        keyring_core::set_default_store(store);

        return Ok(());
    }

    #[cfg(all(
        not(test),
        not(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "windows",
            target_os = "linux",
            target_os = "android"
        ))
    ))]
    Err(SecretsError::unavailable(
        "this platform has no OS credential store",
    ))
}

/// The account one entry lives under, inside `service`.
///
/// `<service>/<account>/password`. The redundant service prefix and the trailing
/// type are the original plugin's format, kept verbatim: they are what an
/// already-installed copy wrote, and the whole point of matching is that upgrading
/// finds its credentials rather than losing them.
fn entry_in(service: &str, account: &str) -> Result<Entry, SecretsError> {
    ensure()?;

    Entry::new(service, &format!("{service}/{account}/password"))
        .map_err(|e| SecretsError::store_failed(format!("the keyring refused the entry: {e}")))
}

/// The canonical entry for `account`.
fn entry(account: &str) -> Result<Entry, SecretsError> {
    entry_in(SERVICE, account)
}

/// Read straight from one service, with a missing entry reported as `None`.
fn read_in(service: &str, account: &str) -> Result<Option<String>, SecretsError> {
    match entry_in(service, account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(e) => Err(SecretsError::store_failed(format!(
            "the keyring refused the read: {e}"
        ))),
    }
}

/// Read one entry. A missing entry is `None`, not an error.
///
/// One round trip. The old JS shim asked `has_password` and then `get_password`,
/// which is two IPC hops and a window in which the answer can change between
/// them — for no gain, since "not there" is exactly what `NoEntry` means.
pub fn read(account: &str) -> Result<Option<String>, SecretsError> {
    if let Some(value) = read_in(SERVICE, account)? {
        return Ok(Some(value));
    }

    // Only now look under the pre-rename service, and migrate what we find. Doing it
    // on read rather than as a startup sweep means we never have to enumerate the
    // store (no backend here can) and a credential moves exactly once, the first time
    // anything actually wants it.
    //
    // ...and only if we have not already established there is nothing there. See
    // LEGACY_CHECKED: without this, an account absent from both services pays two
    // round trips on every read, forever, because a miss migrates nothing and so
    // never settles the question.
    if legacy_known_absent(account) {
        return Ok(None);
    }

    let Some(value) = read_in(LEGACY_SERVICE, account)? else {
        note_legacy_absent(account);

        return Ok(None);
    };

    // Best-effort both ways. A migration that cannot write must still return the
    // credential — the caller wants the value, not the bookkeeping — and a legacy
    // entry we failed to delete is only found again by this same branch next time.
    if let Err(e) = write(account, &value) {
        log::warn!("[secrets] could not migrate {account:?} out of the legacy service: {e}");

        return Ok(Some(value));
    }

    if let Err(e) = remove_in(LEGACY_SERVICE, account) {
        log::warn!("[secrets] migrated {account:?} but could not drop the legacy entry: {e}");
    }

    Ok(Some(value))
}

pub fn write(account: &str, value: &str) -> Result<(), SecretsError> {
    clear_legacy_memo(account);

    entry(account)?
        .set_password(value)
        .map_err(|e| SecretsError::store_failed(format!("the keyring refused the write: {e}")))
}

/// Delete one entry. Already-absent counts as deleted.
///
/// Every other failure is reported. A wipe that quietly failed used to be
/// indistinguishable from one that worked, which is the worst possible answer
/// for the one operation whose entire job is that the credential is gone.
pub fn remove(account: &str) -> Result<(), SecretsError> {
    clear_legacy_memo(account);

    remove_in(SERVICE, account)?;

    // The legacy entry too, and not as an afterthought: this is what "sign out
    // everywhere" calls. Leaving a pre-rename credential behind would let the very
    // next `read` migrate it straight back in, which is the exact opposite of what
    // the user asked for.
    remove_in(LEGACY_SERVICE, account)
}

/// Delete one entry from one service. Already-absent counts as deleted.
fn remove_in(service: &str, account: &str) -> Result<(), SecretsError> {
    match entry_in(service, account)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(e) => Err(SecretsError::store_failed(format!(
            "the keyring refused the delete: {e}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test names are unique per test: the mock store is process-wide and the
    /// harness runs these concurrently.
    #[test]
    fn a_credential_round_trips_under_the_canonical_service() {
        write("store-test-plain", "v1").unwrap();

        assert_eq!(read("store-test-plain").unwrap().as_deref(), Some("v1"));
    }

    #[test]
    fn a_missing_credential_reads_as_none_not_an_error() {
        assert_eq!(read("store-test-absent").unwrap(), None);
    }

    #[test]
    fn a_pre_rename_credential_is_found_and_migrated() {
        // The regression this exists for: the rename moved the service out from
        // under every installed copy, and the OAuth token sets live in it. Before
        // the fallback below, this read answered `None` and the app presented a
        // completed sign-in as "signed out".
        entry_in(LEGACY_SERVICE, "store-test-legacy")
            .unwrap()
            .set_password("legacy-value")
            .unwrap();

        assert_eq!(
            read("store-test-legacy").unwrap().as_deref(),
            Some("legacy-value")
        );

        // Migrated, not merely read: it is now under the canonical service...
        assert_eq!(
            read_in(SERVICE, "store-test-legacy").unwrap().as_deref(),
            Some("legacy-value")
        );
        // ...and gone from the old one, so this costs one round trip, once.
        assert_eq!(read_in(LEGACY_SERVICE, "store-test-legacy").unwrap(), None);
    }

    #[test]
    fn the_canonical_entry_wins_over_a_stale_legacy_one() {
        entry_in(LEGACY_SERVICE, "store-test-both")
            .unwrap()
            .set_password("stale")
            .unwrap();
        write("store-test-both", "current").unwrap();

        assert_eq!(read("store-test-both").unwrap().as_deref(), Some("current"));
    }

    #[test]
    fn removing_clears_the_legacy_entry_too() {
        // Otherwise "sign out everywhere" is a no-op: the next read would find the
        // pre-rename credential and migrate it straight back in.
        entry_in(LEGACY_SERVICE, "store-test-wipe")
            .unwrap()
            .set_password("legacy")
            .unwrap();
        write("store-test-wipe", "current").unwrap();

        remove("store-test-wipe").unwrap();

        assert_eq!(read("store-test-wipe").unwrap(), None);
        assert_eq!(read_in(LEGACY_SERVICE, "store-test-wipe").unwrap(), None);
    }

    /// The memo, proved by its observable consequence: once an account has been
    /// found absent under the legacy service, a value appearing there later is
    /// NOT picked up, because we no longer look. Nothing writes `hermes` at
    /// runtime, so in production that branch is unreachable — planting the entry
    /// by hand is the only way to show the second read skipped the round trip.
    #[test]
    fn the_legacy_service_is_only_searched_once_per_account() {
        assert_eq!(read("store-test-memo").unwrap(), None);

        entry_in(LEGACY_SERVICE, "store-test-memo")
            .unwrap()
            .set_password("planted-after-the-miss")
            .unwrap();

        assert_eq!(read("store-test-memo").unwrap(), None);
    }

    /// Writing makes the question fresh again, so the memo cannot outlive the
    /// state it described.
    #[test]
    fn writing_clears_the_legacy_memo() {
        assert_eq!(read("store-test-memo-write").unwrap(), None);

        write("store-test-memo-write", "current").unwrap();
        entry_in(LEGACY_SERVICE, "store-test-memo-write")
            .unwrap()
            .set_password("legacy")
            .unwrap();

        // The canonical entry still wins, but the point is that `remove` below
        // can now still see and clear the legacy one.
        assert_eq!(
            read("store-test-memo-write").unwrap().as_deref(),
            Some("current")
        );

        remove("store-test-memo-write").unwrap();

        assert_eq!(read("store-test-memo-write").unwrap(), None);
        assert_eq!(
            read_in(LEGACY_SERVICE, "store-test-memo-write").unwrap(),
            None
        );
    }

    /// The invariant the memo could most easily have broken: "sign out
    /// everywhere" must still reach the legacy entry, even for an account whose
    /// legacy miss was memoized before it was ever written.
    #[test]
    fn a_memoized_miss_does_not_survive_a_sign_out() {
        assert_eq!(read("store-test-memo-wipe").unwrap(), None);

        remove("store-test-memo-wipe").unwrap();

        entry_in(LEGACY_SERVICE, "store-test-memo-wipe")
            .unwrap()
            .set_password("legacy")
            .unwrap();

        assert_eq!(
            read("store-test-memo-wipe").unwrap().as_deref(),
            Some("legacy")
        );
    }

    #[test]
    fn removing_an_absent_credential_is_not_an_error() {
        remove("store-test-never-existed").unwrap();
    }
}
