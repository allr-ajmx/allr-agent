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
//!
//! ## macOS: one item, and a vault
//!
//! Everywhere else, one secret is one item in the OS store and the paragraphs
//! above describe the whole design. macOS is different, because of how it
//! authorizes access rather than how it stores things.
//!
//! Each keychain item carries an ACL, and the OS checks it PER ITEM and PER
//! DIRECTION — reading an item and writing it are two separate authorizations. An
//! ACL binds to the requesting code's designated requirement, which an ad-hoc
//! signed bundle does not have (see [`super::code_identity`]), so on such a build
//! every one of those checks is a password dialog and "Always Allow" has nothing
//! to stick to. Two stored credentials cost four dialogs a launch: read the
//! cookie jar, read the token set, write the jar back, write the rotated token
//! set back.
//!
//! So on macOS this store keeps exactly one keychain item — [`MASTER_KEY_ACCOUNT`],
//! a random 32-byte key — and every secret lives in a file that key seals, at
//! `<app data dir>/secrets.vault` (see [`super::vault`]). One ACL check per
//! launch, no matter how many credentials there are or how often they are
//! written. A signed build binds that one check once and never prompts again; an
//! ad-hoc build shows one dialog per launch instead of one per access.
//!
//! Credentials already in the keychain migrate into the vault lazily, per account
//! on first read, and the keychain item is dropped once they land — the same
//! shape as the pre-rename migration above, and for the same reason: nothing here
//! can enumerate a service, and `nativeAuth:<gateway>` accounts are named after
//! URLs this process may not have seen yet.

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

/// The account the vault's master key is stored under, inside [`SERVICE`].
///
/// On macOS this is the ONLY keychain item this app keeps, and it is not a
/// credential — it is the key that seals every credential. Public so `mod.rs` can
/// assert that nothing nameable from a webview lands on it: routing a secret onto
/// this account would hand out the key to all of them, and signing out would
/// delete it and orphan the whole vault.
///
/// It needs no namespace prefix to stay clear of the rest. Every `SecretKey`
/// account is checked against it by test, and `OwnedKey`'s accounts all carry a
/// `:` that this one does not.
pub const MASTER_KEY_ACCOUNT: &str = "vaultKey";

/// Whether the process-wide default store has been installed.
///
/// A `Mutex<bool>` rather than a `OnceLock`, because failure must stay
/// retryable. On Android the store cannot be built until `ndk_context` has been
/// populated from the Java side, and caching that one early failure forever
/// would disable credential storage for the whole run.
static READY: Mutex<bool> = Mutex::new(false);

// --------------------------------------------------------------------------
// The keychain tier
// --------------------------------------------------------------------------
//
// One item per secret, which is how every platform but macOS stores them. The
// `cfg(any(test, not(target_os = "macos")))` on each item below is the negation
// of the one on the vault dispatch further down: on a real macOS build the vault
// reaches `read_in`/`remove_in` itself and runs its own migration, so these
// wrappers and the memo they carry would be dead code there. Under `cargo test`
// they stay compiled on every platform, because they are what the tests at the
// bottom of this file exercise.

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
#[cfg(any(test, not(target_os = "macos")))]
static LEGACY_CHECKED: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

/// Has `account` already been looked for under the legacy service and missed?
#[cfg(any(test, not(target_os = "macos")))]
fn legacy_known_absent(account: &str) -> bool {
    LEGACY_CHECKED
        .lock()
        .ok()
        .and_then(|memo| memo.as_ref().map(|seen| seen.contains(account)))
        .unwrap_or(false)
}

/// Record that the legacy service holds nothing for `account`.
#[cfg(any(test, not(target_os = "macos")))]
fn note_legacy_absent(account: &str) {
    if let Ok(mut memo) = LEGACY_CHECKED.lock() {
        memo.get_or_insert_with(std::collections::HashSet::new)
            .insert(account.to_string());
    }
}

/// Forget that memo for `account`.
///
/// Called from `write` and `remove` because both make the legacy question fresh
/// again: `remove` clears BOTH services, and a later `write` then `remove` must
/// still leave `read` able to prove the legacy entry is gone rather than assuming
/// it from a memo taken before either ran.
#[cfg(any(test, not(target_os = "macos")))]
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
#[cfg(any(test, not(target_os = "macos")))]
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

/// Read one entry from the keychain tier. A missing entry is `None`, not an error.
///
/// One round trip. The old JS shim asked `has_password` and then `get_password`,
/// which is two IPC hops and a window in which the answer can change between
/// them — for no gain, since "not there" is exactly what `NoEntry` means.
#[cfg(any(test, not(target_os = "macos")))]
fn keychain_read(account: &str) -> Result<Option<String>, SecretsError> {
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
    if let Err(e) = keychain_write(account, &value) {
        log::warn!("[secrets] could not migrate {account:?} out of the legacy service: {e}");

        return Ok(Some(value));
    }

    if let Err(e) = remove_in(LEGACY_SERVICE, account) {
        log::warn!("[secrets] migrated {account:?} but could not drop the legacy entry: {e}");
    }

    Ok(Some(value))
}

#[cfg(any(test, not(target_os = "macos")))]
fn keychain_write(account: &str, value: &str) -> Result<(), SecretsError> {
    clear_legacy_memo(account);

    entry(account)?
        .set_password(value)
        .map_err(|e| SecretsError::store_failed(format!("the keyring refused the write: {e}")))
}

/// Delete one entry from the keychain tier. Already-absent counts as deleted.
///
/// Every other failure is reported. A wipe that quietly failed used to be
/// indistinguishable from one that worked, which is the worst possible answer
/// for the one operation whose entire job is that the credential is gone.
#[cfg(any(test, not(target_os = "macos")))]
fn keychain_remove(account: &str) -> Result<(), SecretsError> {
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

// --------------------------------------------------------------------------
// The public API, and which tier answers it
// --------------------------------------------------------------------------
//
// Everywhere but macOS, one secret is one keychain/keystore item and these are
// the keychain functions above, unchanged.
//
// On macOS they go through the vault, which holds one item and a sealed file —
// see [`vaulted`]. Under `cargo test` they deliberately do NOT: the tests below
// exercise the keychain tier against `keyring_core::mock`, and the vault has its
// own tests that stack a temp file on top of that same mock.

/// Read one entry. A missing entry is `None`, not an error.
#[allow(clippy::needless_return)]
pub fn read(account: &str) -> Result<Option<String>, SecretsError> {
    #[cfg(all(not(test), target_os = "macos"))]
    {
        return vaulted::with_global(|vault| vault.read(account));
    }

    #[cfg(not(all(not(test), target_os = "macos")))]
    {
        return keychain_read(account);
    }
}

/// Write one entry.
#[allow(clippy::needless_return)]
pub fn write(account: &str, value: &str) -> Result<(), SecretsError> {
    #[cfg(all(not(test), target_os = "macos"))]
    {
        return vaulted::with_global(|vault| vault.write(account, value));
    }

    #[cfg(not(all(not(test), target_os = "macos")))]
    {
        return keychain_write(account, value);
    }
}

/// Delete one entry. Already-absent counts as deleted.
#[allow(clippy::needless_return)]
pub fn remove(account: &str) -> Result<(), SecretsError> {
    #[cfg(all(not(test), target_os = "macos"))]
    {
        return vaulted::with_global(|vault| vault.remove(account));
    }

    #[cfg(not(all(not(test), target_os = "macos")))]
    {
        return keychain_remove(account);
    }
}

/// Tell the store where the sealed vault lives.
///
/// Must be called before any command can be dispatched — from the Tauri `setup`
/// hook, which is the last thing to run before the webview can invoke anything.
/// A macOS read or write that arrives before it does is refused rather than
/// silently answered from the wrong place.
///
/// Defined on every platform, and a no-op off macOS, so the caller does not need
/// a `cfg` for a fact about storage that storage should own.
pub fn configure(app_data_dir: std::path::PathBuf) {
    #[cfg(all(not(test), target_os = "macos"))]
    {
        vaulted::configure(app_data_dir);
    }

    #[cfg(not(all(not(test), target_os = "macos")))]
    {
        let _ = app_data_dir;
    }
}

// --------------------------------------------------------------------------
// The vault tier
// --------------------------------------------------------------------------

/// One keychain item, and a sealed file holding everything else.
///
/// Compiled under `cfg(test)` on every platform as well as on macOS, so the
/// migration logic — the part with a real chance of orphaning a credential — is
/// tested on the machine doing the review rather than only on the one running
/// the release.
#[cfg(any(test, target_os = "macos"))]
mod vaulted {
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    #[cfg(not(test))]
    use std::sync::Mutex;

    use super::super::vault;
    use super::{
        entry_in, read_in, remove_in, SecretsError, LEGACY_SERVICE, MASTER_KEY_ACCOUNT, SERVICE,
    };

    /// The vault, once its key has been fetched.
    pub struct Vault {
        path: PathBuf,
        key: vault::MasterKey,
        /// Accounts already looked for in the keychain — under BOTH services —
        /// and not found.
        ///
        /// The same idea as `LEGACY_CHECKED` one tier down, generalized: after
        /// this store stops writing keychain items, EVERY account is a migration
        /// candidate on first read, and an account that exists in neither service
        /// would otherwise pay two keychain round trips on every single read,
        /// forever, because a miss migrates nothing and so never settles the
        /// question.
        checked: HashSet<String>,
    }

    impl Vault {
        pub fn new(dir: &Path, key: vault::MasterKey) -> Self {
            Self {
                path: dir.join(vault::FILE_NAME),
                key,
                checked: HashSet::new(),
            }
        }

        /// Read one account: the vault first, then the keychain, migrating what
        /// it finds.
        ///
        /// Lazily, per account, and not as a startup sweep — for the same reason
        /// the pre-rename migration one tier down is lazy: no backend here can
        /// enumerate a service, and `nativeAuth:<base>` accounts are named after
        /// gateway URLs this process may not have seen yet. A credential moves
        /// exactly once, the first time something actually wants it.
        pub fn read(&mut self, account: &str) -> Result<Option<String>, SecretsError> {
            let mut map = vault::load(&self.key, &self.path)?;

            if let Some(value) = map.get(account) {
                return Ok(Some(value.clone()));
            }

            if self.checked.contains(account) {
                return Ok(None);
            }

            for service in [SERVICE, LEGACY_SERVICE] {
                let Some(value) = read_in(service, account)? else {
                    continue;
                };

                map.insert(account.to_string(), value.clone());

                // Best-effort both ways, exactly as the legacy migration is: the
                // caller wants the credential, not the bookkeeping. A migration
                // that could not be saved must NOT delete the keychain item and
                // must NOT be memoized, or the next read finds nothing anywhere.
                if let Err(e) = vault::save(&self.key, &self.path, &map) {
                    log::warn!(
                        "[secrets] could not move {account:?} into the vault: {}",
                        e.message
                    );

                    return Ok(Some(value));
                }

                if let Err(e) = remove_in(service, account) {
                    log::warn!(
                        "[secrets] moved {account:?} into the vault but could not drop the \
                         keychain item: {}",
                        e.message
                    );
                }

                self.checked.insert(account.to_string());

                return Ok(Some(value));
            }

            self.checked.insert(account.to_string());

            Ok(None)
        }

        pub fn write(&mut self, account: &str, value: &str) -> Result<(), SecretsError> {
            let mut map = vault::load(&self.key, &self.path)?;

            map.insert(account.to_string(), value.to_string());

            vault::save(&self.key, &self.path, &map)
        }

        /// Forget one account, everywhere it could be.
        ///
        /// The keychain sweep is unconditional and ignores the memo. This is what
        /// "sign out everywhere" calls, and an account whose absence was memoized
        /// before it was ever written must still have its keychain items deleted
        /// — otherwise the very next read migrates the credential straight back
        /// in, which is the exact opposite of what was asked for.
        pub fn remove(&mut self, account: &str) -> Result<(), SecretsError> {
            let mut map = vault::load(&self.key, &self.path)?;

            if map.remove(account).is_some() {
                vault::save(&self.key, &self.path, &map)?;
            }

            remove_in(SERVICE, account)?;
            remove_in(LEGACY_SERVICE, account)?;

            // Cleared rather than set: the memo must not outlive the state it
            // described. Re-asking costs one round trip on the next read, and a
            // search for an item that is not there raises no dialog.
            self.checked.remove(account);

            Ok(())
        }
    }

    /// How far along the vault is.
    ///
    /// Three states rather than an `Option`, because "nobody told us where it
    /// lives" and "we know where it lives but have not opened it" fail
    /// differently: the first is a wiring bug worth naming, the second is a
    /// retryable I/O outcome.
    pub enum Slot {
        Unconfigured,
        Pending(PathBuf),
        Open(Vault),
    }

    impl Slot {
        /// Open the vault, fetching the key if this is the first time.
        ///
        /// A failure leaves the slot `Pending`, so the next call tries again —
        /// the same reasoning that makes `READY` a `Mutex<bool>` and not a
        /// `OnceLock`. The one failure that matters here is the user dismissing
        /// the keychain dialog, and caching that for the life of the process
        /// would turn one cancelled prompt into a session with no credentials.
        pub fn open(
            &mut self,
            load_key: impl FnOnce() -> Result<vault::MasterKey, SecretsError>,
        ) -> Result<&mut Vault, SecretsError> {
            if let Self::Pending(dir) = self {
                let dir = dir.clone();

                *self = Self::Open(Vault::new(&dir, load_key()?));
            }

            match self {
                Self::Open(vault) => Ok(vault),
                _ => Err(SecretsError::unavailable(
                    "the credential vault was not configured at startup",
                )),
            }
        }
    }

    // The process-wide vault, and the two entry points onto it.
    //
    // Only on a real macOS build: under `cargo test` the dispatchers above route
    // to the keychain tier, and the tests below drive `Vault` and `Slot` directly
    // rather than through a global whose state would leak between them.
    #[cfg(not(test))]
    static VAULT: Mutex<Slot> = Mutex::new(Slot::Unconfigured);

    /// Point the vault at a directory. Idempotent; a second call is ignored.
    #[cfg(not(test))]
    pub fn configure(dir: PathBuf) {
        let mut slot = VAULT.lock().unwrap_or_else(|p| p.into_inner());

        if matches!(*slot, Slot::Unconfigured) {
            *slot = Slot::Pending(dir);
        }
    }

    /// Run `f` against the process-wide vault.
    ///
    /// The mutex is held across the whole call — including the keychain dialog
    /// the first read may raise, and including load-modify-save. Both are
    /// deliberate: two threads racing the bootstrap would each mint a key and one
    /// of the two vaults would then be unopenable, and two threads racing a write
    /// would lose one of the two secrets. Boot does race — the frontend restores
    /// the cookie jar while the transport looks for a bearer token.
    ///
    /// Never call this from the main thread. Every caller reaches it through
    /// `mod.rs::blocking`, which is what keeps a modal keychain dialog off the
    /// thread that would have to draw it.
    #[cfg(not(test))]
    pub fn with_global<T>(
        f: impl FnOnce(&mut Vault) -> Result<T, SecretsError>,
    ) -> Result<T, SecretsError> {
        let mut slot = VAULT.lock().unwrap_or_else(|p| p.into_inner());

        f(slot.open(load_or_create_master_key)?)
    }

    /// The key that seals the vault: read from the keychain, or minted and stored
    /// on first use.
    ///
    /// This is THE keychain access — the only one a launch makes once every
    /// credential has migrated. On an ad-hoc signed build it is the one password
    /// dialog the user sees; on a Developer ID build the ACL binds once and they
    /// see none.
    ///
    /// A stored value that will not parse is an error and never a reason to mint
    /// a replacement: the new key would seal the next write under something that
    /// cannot open the existing vault, orphaning every credential in it and
    /// reporting success. Signing in again is recoverable; that is not.
    fn load_or_create_master_key() -> Result<vault::MasterKey, SecretsError> {
        if let Some(encoded) = read_in(SERVICE, MASTER_KEY_ACCOUNT)? {
            return vault::MasterKey::from_base64(&encoded);
        }

        let key = vault::MasterKey::generate()?;

        entry_in(SERVICE, MASTER_KEY_ACCOUNT)?
            .set_password(&key.to_base64())
            .map_err(|e| {
                SecretsError::store_failed(format!("the keyring refused the vault key: {e}"))
            })?;

        Ok(key)
    }

    /// Reach `load_or_create_master_key` from the tests one module up.
    #[cfg(test)]
    pub(super) fn master_key_for_test() -> Result<vault::MasterKey, SecretsError> {
        load_or_create_master_key()
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

/// The vault tier, stacked on the same mock store the tests above use.
///
/// The mock plays the keychain, a scratch directory plays the app data dir, and
/// the key is fixed — so what is being tested is the migration order and the
/// memo, not the file format (which `vault` covers) and not the real Keychain.
#[cfg(test)]
mod vault_tests {
    use super::vaulted::{Slot, Vault};
    use super::*;
    use crate::secrets::error::SecretsErrorKind;
    use crate::secrets::vault;

    fn key() -> vault::MasterKey {
        vault::MasterKey::from_bytes([3u8; vault::KEY_LEN])
    }

    /// A vault over its own scratch directory. The `TempDir` is returned because
    /// dropping it deletes the directory out from under the vault.
    ///
    /// The directory is per-test, but the mock keychain underneath is
    /// process-wide and the harness runs these concurrently — hence the unique
    /// account name in every test below.
    fn scratch_vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path(), key());

        (dir, vault)
    }

    /// Put a value in one keychain service, as a pre-vault build would have.
    fn plant(service: &str, account: &str, value: &str) {
        entry_in(service, account)
            .unwrap()
            .set_password(value)
            .unwrap();
    }

    #[test]
    fn a_write_is_served_back_without_touching_the_keychain() {
        // The entire point: after this, reads and writes cost no ACL check at
        // all, which is what removes the per-credential password dialog.
        let (_dir, mut vault) = scratch_vault();

        vault.write("vault-test-plain", "v1").unwrap();

        assert_eq!(
            vault.read("vault-test-plain").unwrap().as_deref(),
            Some("v1")
        );
        assert_eq!(read_in(SERVICE, "vault-test-plain").unwrap(), None);
        assert_eq!(read_in(LEGACY_SERVICE, "vault-test-plain").unwrap(), None);
    }

    #[test]
    fn a_missing_credential_reads_as_none_not_an_error() {
        let (_dir, mut vault) = scratch_vault();

        assert_eq!(vault.read("vault-test-absent").unwrap(), None);
    }

    #[test]
    fn a_keychain_credential_is_migrated_into_the_vault_and_dropped() {
        // The upgrade path. Every installed copy has its credentials as keychain
        // items; getting them into the vault is what makes the second launch
        // prompt-free, and dropping the item is what stops it being found again.
        let (_dir, mut vault) = scratch_vault();
        plant(SERVICE, "vault-test-migrate", "from-the-keychain");

        assert_eq!(
            vault.read("vault-test-migrate").unwrap().as_deref(),
            Some("from-the-keychain")
        );

        assert_eq!(read_in(SERVICE, "vault-test-migrate").unwrap(), None);

        // ...and it is genuinely in the vault, not merely passed through.
        let mut fresh = Vault::new(_dir.path(), key());
        assert_eq!(
            fresh.read("vault-test-migrate").unwrap().as_deref(),
            Some("from-the-keychain")
        );
    }

    #[test]
    fn a_pre_rename_credential_is_migrated_too() {
        // Two migrations deep: `hermes` → `allr` was never finished for installs
        // that skipped a version, and the vault must not be the thing that
        // finally orphans them.
        let (_dir, mut vault) = scratch_vault();
        plant(LEGACY_SERVICE, "vault-test-legacy", "pre-rename");

        assert_eq!(
            vault.read("vault-test-legacy").unwrap().as_deref(),
            Some("pre-rename")
        );

        assert_eq!(read_in(LEGACY_SERVICE, "vault-test-legacy").unwrap(), None);
    }

    #[test]
    fn the_canonical_keychain_item_wins_over_a_legacy_one() {
        let (_dir, mut vault) = scratch_vault();
        plant(LEGACY_SERVICE, "vault-test-both", "stale");
        plant(SERVICE, "vault-test-both", "current");

        assert_eq!(
            vault.read("vault-test-both").unwrap().as_deref(),
            Some("current")
        );
    }

    #[test]
    fn the_vault_wins_over_a_stale_keychain_item() {
        let (_dir, mut vault) = scratch_vault();
        plant(SERVICE, "vault-test-stale", "stale");
        vault.write("vault-test-stale", "current").unwrap();

        assert_eq!(
            vault.read("vault-test-stale").unwrap().as_deref(),
            Some("current")
        );
        // Untouched: nothing migrated, because nothing needed to.
        assert_eq!(
            read_in(SERVICE, "vault-test-stale").unwrap().as_deref(),
            Some("stale")
        );
    }

    #[test]
    fn the_keychain_is_searched_once_per_account() {
        // The memo, proved by its observable consequence. Without it, every
        // credential the user never set costs two keychain round trips on every
        // read, forever — and on macOS a round trip is an ACL check.
        let (_dir, mut vault) = scratch_vault();

        assert_eq!(vault.read("vault-test-memo").unwrap(), None);

        plant(SERVICE, "vault-test-memo", "planted-after-the-miss");

        assert_eq!(vault.read("vault-test-memo").unwrap(), None);
    }

    #[test]
    fn removing_sweeps_the_vault_and_both_keychain_services() {
        // "Sign out everywhere" has to reach all three, or the next read migrates
        // the credential straight back in.
        let (_dir, mut vault) = scratch_vault();
        plant(LEGACY_SERVICE, "vault-test-wipe", "legacy");
        plant(SERVICE, "vault-test-wipe", "canonical");
        vault.write("vault-test-wipe", "current").unwrap();

        vault.remove("vault-test-wipe").unwrap();

        assert_eq!(vault.read("vault-test-wipe").unwrap(), None);
        assert_eq!(read_in(SERVICE, "vault-test-wipe").unwrap(), None);
        assert_eq!(read_in(LEGACY_SERVICE, "vault-test-wipe").unwrap(), None);
    }

    #[test]
    fn a_memoized_miss_does_not_survive_a_sign_out() {
        // The invariant the memo could most easily have broken: `remove` must
        // still sweep the keychain for an account whose absence was memoized
        // before it was ever written there.
        let (_dir, mut vault) = scratch_vault();

        assert_eq!(vault.read("vault-test-memo-wipe").unwrap(), None);

        vault.remove("vault-test-memo-wipe").unwrap();

        plant(SERVICE, "vault-test-memo-wipe", "planted");

        assert_eq!(
            vault.read("vault-test-memo-wipe").unwrap().as_deref(),
            Some("planted")
        );
    }

    /// A vault whose directory refuses writes. Skipped where the process can
    /// write anywhere anyway (running as root), because there the premise does
    /// not hold rather than the behaviour being wrong.
    #[cfg(unix)]
    fn read_only_dir() -> Option<tempfile::TempDir> {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().unwrap();
        let mut perms = std::fs::metadata(dir.path()).unwrap().permissions();
        perms.set_mode(0o500);
        std::fs::set_permissions(dir.path(), perms).unwrap();

        if std::fs::write(dir.path().join("probe"), b"x").is_ok() {
            return None;
        }

        Some(dir)
    }

    #[cfg(unix)]
    #[test]
    fn a_migration_that_cannot_be_saved_still_returns_the_credential() {
        // The caller wants the value, not the bookkeeping — and the keychain item
        // must survive, or a failed save would destroy the only copy of it.
        let Some(dir) = read_only_dir() else {
            return;
        };

        let mut vault = Vault::new(dir.path(), key());
        plant(SERVICE, "vault-test-unsaveable", "still-here");

        assert_eq!(
            vault.read("vault-test-unsaveable").unwrap().as_deref(),
            Some("still-here")
        );
        assert_eq!(
            read_in(SERVICE, "vault-test-unsaveable")
                .unwrap()
                .as_deref(),
            Some("still-here")
        );

        // Not memoized either, so a later launch with a working directory picks
        // the migration back up rather than reporting the credential gone.
        assert_eq!(
            vault.read("vault-test-unsaveable").unwrap().as_deref(),
            Some("still-here")
        );
    }

    #[test]
    fn a_vault_that_cannot_be_read_is_an_error_rather_than_an_empty_one() {
        // "Nothing stored" and "could not look" must not be the same answer. If
        // an unreadable vault read as empty, the app would report the user signed
        // out and then overwrite the file they were actually signed in with.
        let dir = tempfile::tempdir().unwrap();

        // A file where the vault expects its directory.
        let wedged = dir.path().join("wedged");
        std::fs::write(&wedged, b"not a directory").unwrap();

        let mut vault = Vault::new(&wedged, key());

        assert!(vault.read("vault-test-unreadable").is_err());
    }

    #[test]
    fn an_unconfigured_slot_refuses_rather_than_answering_from_nowhere() {
        let refused = match Slot::Unconfigured.open(|| Ok(key())) {
            Err(refused) => refused,
            Ok(_) => panic!("an unconfigured vault must not answer"),
        };

        assert_eq!(refused.kind, SecretsErrorKind::Unavailable);
    }

    #[test]
    fn a_failed_key_fetch_leaves_the_slot_retryable() {
        // The failure that matters is the user dismissing the keychain dialog.
        // Caching that for the life of the process would turn one cancelled
        // prompt into a session with no credentials at all.
        let dir = tempfile::tempdir().unwrap();
        let mut slot = Slot::Pending(dir.path().to_path_buf());

        assert!(slot
            .open(|| Err(SecretsError::locked("dismissed")))
            .is_err());

        assert!(slot.open(|| Ok(key())).is_ok());
    }

    #[test]
    fn the_master_key_is_minted_once_and_read_back_after() {
        let first = super::vaulted::master_key_for_test().unwrap();
        let second = super::vaulted::master_key_for_test().unwrap();

        assert_eq!(&*first.to_base64(), &*second.to_base64());

        // 32 bytes of padded base64 — the shape to eyeball in Keychain Access
        // when checking that exactly one item is there.
        assert_eq!(first.to_base64().len(), 44);
        assert_eq!(
            read_in(SERVICE, MASTER_KEY_ACCOUNT).unwrap().as_deref(),
            Some(first.to_base64().as_str())
        );
    }
}
