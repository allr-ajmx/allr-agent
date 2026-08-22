//! An AES-256-GCM sealed map of account → secret, in one file.
//!
//! This exists because of how macOS authorizes access to the login keychain. Each
//! keychain item carries its own ACL, and the OS checks it PER ITEM and PER
//! DIRECTION — reading an item and writing it are two separate authorizations. On
//! a build whose code signature the ACL cannot bind to, every one of those checks
//! is a password dialog. Two stored credentials therefore cost four dialogs a
//! launch: read the cookie jar, read the token set, write the cookie jar back,
//! write the rotated token set back.
//!
//! Caching cuts repeats, and the branch that led here did exactly that. What it
//! cannot do is get below one dialog per item per direction, because each of those
//! is a first access to a distinct item.
//!
//! So: keep ONE keychain item — a random 32-byte key — and put every secret in a
//! file this key seals. One ACL check per launch, whatever the app stores and
//! however often it writes. The trade is explicit: the sealed file is protected by
//! a key in the keychain plus the filesystem's own permissions, rather than by an
//! ACL per secret. On this platform that ACL was never the load-bearing part —
//! the login keychain has no `kSecAccessControl` binding here (that needs a Data
//! Protection entitlement this bundle cannot carry, see `store::install`) — so
//! what is actually given up is the per-item dialog, which is the thing being
//! removed on purpose.
//!
//! Deliberately platform-agnostic and free of globals: it takes a key and a path
//! and does not know what a keychain is. The macOS wiring lives in
//! [`super::store`], and these tests run on every platform because a file format
//! that only its own target can exercise is a file format nobody checks.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Nonce, Payload};
use aes_gcm::Aes256Gcm;
use zeroize::Zeroizing;

use super::error::SecretsError;

/// The sealed file's name, inside the app data directory.
pub const FILE_NAME: &str = "secrets.vault";

/// Four bytes that say what this file is, so a truncated or unrelated file is
/// rejected as malformed rather than handed to the cipher as ciphertext.
const MAGIC: [u8; 4] = *b"ALRV";

/// The format version. Bump only alongside a reader for the old one.
const VERSION: u8 = 1;

/// `MAGIC` + `VERSION`. These bytes are also the AAD — see [`header`].
const HEADER_LEN: usize = MAGIC.len() + 1;

/// AES-GCM's nonce size. Fresh per write, never reused under one key.
const NONCE_LEN: usize = 12;

/// AES-256.
pub const KEY_LEN: usize = 32;

/// What the vault holds: account name → secret value.
///
/// The same account strings the keychain used (`token`, `cookies`,
/// `nativeAuth:<base>`, …), so [`super::store`] can hand them straight through
/// and nothing above it has to learn a second naming scheme.
///
/// A `BTreeMap` rather than a `HashMap` so the serialized bytes are a function of
/// the contents alone. Two saves of the same map produce the same plaintext,
/// which is what makes "did this actually change" answerable at all.
pub type Map = BTreeMap<String, String>;

/// The header, which is also the additional authenticated data.
///
/// Using the header as AAD binds the version to the tag: a file whose version
/// byte has been edited fails authentication rather than being decrypted under
/// rules it was not written with. It costs nothing — these bytes are on disk
/// either way.
fn header() -> [u8; HEADER_LEN] {
    [MAGIC[0], MAGIC[1], MAGIC[2], MAGIC[3], VERSION]
}

/// The key that seals the vault.
///
/// Held in `Zeroizing` so the bytes are wiped when the last copy drops. That is a
/// real but bounded promise: this key is deliberately resident for the whole
/// process lifetime (that is the point — it is what avoids re-prompting), so what
/// zeroizing buys is that a dropped copy does not linger in freed memory or in a
/// core dump, not that the key is absent from RAM.
pub struct MasterKey(Zeroizing<[u8; KEY_LEN]>);

impl MasterKey {
    /// A fresh key from the platform CSPRNG.
    pub fn generate() -> Result<Self, SecretsError> {
        let mut bytes = Zeroizing::new([0u8; KEY_LEN]);

        // Unlike the token-generating callers elsewhere in this crate, a failure
        // here is NOT survivable by carrying on: a weak or unwritten key would
        // seal every credential this app holds.
        getrandom::getrandom(&mut *bytes).map_err(|e| {
            SecretsError::store_failed(format!("could not generate a vault key: {e}"))
        })?;

        Ok(Self(bytes))
    }

    /// Build one from raw bytes. The test seam, and the only way to get a
    /// reproducible key.
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// Parse the form stored in the keychain.
    ///
    /// A wrong length is an error and never a reason to mint a replacement.
    /// Generating a new key here would seal the next write under something that
    /// cannot open the existing vault — every stored credential orphaned, and
    /// reported as success. Signing in again is recoverable; that is not.
    pub fn from_base64(encoded: &str) -> Result<Self, SecretsError> {
        use base64::Engine as _;

        let decoded = Zeroizing::new(
            base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .map_err(|e| {
                    SecretsError::store_failed(format!("the stored vault key is not base64: {e}"))
                })?,
        );

        let bytes: [u8; KEY_LEN] = decoded.as_slice().try_into().map_err(|_| {
            SecretsError::store_failed(format!(
                "the stored vault key is {} bytes, not {KEY_LEN}",
                decoded.len()
            ))
        })?;

        Ok(Self::from_bytes(bytes))
    }

    /// The form written to the keychain.
    pub fn to_base64(&self) -> Zeroizing<String> {
        use base64::Engine as _;

        Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&*self.0))
    }

    fn cipher(&self) -> Result<Aes256Gcm, SecretsError> {
        Aes256Gcm::new_from_slice(&*self.0)
            .map_err(|e| SecretsError::store_failed(format!("the vault key was refused: {e}")))
    }
}

/// Why a vault file could not be read back.
///
/// Separated from [`SecretsError`] because these are not failures to report
/// upward — every one of them is handled identically by [`load`] and the
/// distinction only ever reaches a log line. Keeping them named means that log
/// line can say WHICH, which is the difference between "the key was replaced" and
/// "the disk truncated the file".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    /// Not a vault file, or not enough of one: bad magic, or shorter than a
    /// header plus a nonce.
    Malformed(&'static str),
    /// A vault file from a version this build has no reader for.
    UnknownVersion(u8),
    /// The right shape, but this key does not open it — a replaced keychain item,
    /// or tampering. Indistinguishable by design: AEAD does not say which.
    Undecryptable,
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(why) => write!(f, "malformed ({why})"),
            Self::UnknownVersion(v) => write!(
                f,
                "written by format version {v}, which this build cannot read"
            ),
            Self::Undecryptable => write!(f, "the vault key does not open it"),
        }
    }
}

/// Seal a map. A fresh nonce every call — reusing one under the same key is what
/// breaks GCM, so it is generated here rather than passed in.
pub fn seal(key: &MasterKey, map: &Map) -> Result<Vec<u8>, SecretsError> {
    let plaintext =
        Zeroizing::new(serde_json::to_vec(map).map_err(|e| {
            SecretsError::store_failed(format!("could not serialize the vault: {e}"))
        })?);

    let mut nonce_bytes = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce_bytes).map_err(|e| {
        SecretsError::store_failed(format!("could not generate a vault nonce: {e}"))
    })?;

    let nonce = Nonce::<Aes256Gcm>::try_from(&nonce_bytes[..])
        .map_err(|e| SecretsError::store_failed(format!("the vault nonce was refused: {e}")))?;

    let aad = header();

    let ciphertext = key
        .cipher()?
        .encrypt(
            &nonce,
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        // The error carries nothing about the plaintext, and must not: this
        // message goes to a log the user may well paste into an issue.
        .map_err(|_| SecretsError::store_failed("the vault could not be sealed"))?;

    let mut out = Vec::with_capacity(HEADER_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&aad);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);

    Ok(out)
}

/// Open sealed bytes.
pub fn open(key: &MasterKey, bytes: &[u8]) -> Result<Map, OpenError> {
    if bytes.len() < HEADER_LEN + NONCE_LEN {
        return Err(OpenError::Malformed("shorter than a header and a nonce"));
    }

    if bytes[..MAGIC.len()] != MAGIC {
        return Err(OpenError::Malformed("not a vault file"));
    }

    let version = bytes[MAGIC.len()];

    // Checked before the AAD does it implicitly, so a future version reads as
    // exactly that rather than as "your key is wrong".
    if version != VERSION {
        return Err(OpenError::UnknownVersion(version));
    }

    let (aad, rest) = bytes.split_at(HEADER_LEN);
    let (nonce_bytes, ciphertext) = rest.split_at(NONCE_LEN);

    let nonce = Nonce::<Aes256Gcm>::try_from(nonce_bytes).map_err(|_| OpenError::Undecryptable)?;

    let plaintext = Zeroizing::new(
        key.cipher()
            .map_err(|_| OpenError::Undecryptable)?
            .decrypt(
                &nonce,
                Payload {
                    msg: ciphertext,
                    aad,
                },
            )
            .map_err(|_| OpenError::Undecryptable)?,
    );

    // Authenticated bytes that will not parse mean this build and the writer
    // disagree about the plaintext, which is a format problem, not a key one.
    serde_json::from_slice(&plaintext)
        .map_err(|_| OpenError::Malformed("the sealed body is not a map"))
}

/// The map on disk, or an empty one when there is nothing readable there.
///
/// An unreadable file is NOT an error and is NOT deleted. Refusing every read
/// would wedge credential storage behind a file the user has never heard of, and
/// deleting destroys the only evidence of what went wrong — a replaced keychain
/// item, a keychain reset, a downgrade. It is logged loudly and quarantined by
/// the next [`save`], which keeps the bytes recoverable if the old key turns up.
///
/// A file that is present but cannot be READ (permissions, a bad mount) is a
/// different thing and does surface, because silently treating it as empty would
/// sign the user out and then cheerfully overwrite it.
pub fn load(key: &MasterKey, path: &Path) -> Result<Map, SecretsError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => {
            return Err(SecretsError::store_failed(format!(
                "could not read {}: {e}",
                path.display()
            )))
        }
    };

    match open(key, &bytes) {
        Ok(map) => Ok(map),
        Err(why) => {
            log::error!(
                "[secrets] the vault at {} could not be opened: {why}. Treating it as empty; it \
                 will be set aside rather than overwritten, and you will be asked to sign in again.",
                path.display()
            );

            Ok(Map::new())
        }
    }
}

/// Write the map, atomically.
///
/// Seals to a sibling temp file, fsyncs it, then renames over the target — so a
/// crash mid-write leaves either the old vault or the new one, never a truncated
/// file that reads as "no credentials". The temp file is a sibling precisely so
/// the rename stays within one filesystem, where it is atomic.
pub fn save(key: &MasterKey, path: &Path, map: &Map) -> Result<(), SecretsError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| {
            SecretsError::store_failed(format!("could not create {}: {e}", dir.display()))
        })?;
    }

    quarantine_if_unreadable(key, path);

    let sealed = seal(key, map)?;
    let tmp = temp_path(path);

    write_private(&tmp, &sealed)?;

    std::fs::rename(&tmp, path).map_err(|e| {
        // A rename that failed leaves the temp file holding sealed credentials.
        let _ = std::fs::remove_file(&tmp);

        SecretsError::store_failed(format!("could not replace {}: {e}", path.display()))
    })
}

/// `<path>.tmp`, as a sibling of the target.
fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");

    path.with_file_name(name)
}

/// Create (or truncate) `path` owner-only and write `bytes`.
///
/// The mode is set at open time rather than with a later `set_permissions`, so
/// there is no window in which the file exists group- or world-readable holding
/// sealed — but still stolen-and-offline-attackable — credentials.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), SecretsError> {
    use std::io::Write as _;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;

        options.mode(0o600);
    }

    let mut file = options.open(path).map_err(|e| {
        SecretsError::store_failed(format!("could not open {}: {e}", path.display()))
    })?;

    file.write_all(bytes).map_err(|e| {
        SecretsError::store_failed(format!("could not write {}: {e}", path.display()))
    })?;

    // Durability before the rename, or the rename can land ahead of the bytes.
    file.sync_all()
        .map_err(|e| SecretsError::store_failed(format!("could not flush {}: {e}", path.display())))
}

/// Move an existing-but-unopenable vault aside, once, before overwriting it.
///
/// Best-effort throughout: this runs on the way to a write that must still
/// happen, and a vault we cannot open is one whose contents are already lost to
/// us. Failing the write because the salvage failed would help nobody.
fn quarantine_if_unreadable(key: &MasterKey, path: &Path) {
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };

    let Err(why) = open(key, &bytes) else {
        return;
    };

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".unreadable-{stamp}"));

    let aside = path.with_file_name(name);

    match std::fs::rename(path, &aside) {
        Ok(()) => log::error!(
            "[secrets] the previous vault could not be opened ({why}); it has been kept at {} \
             rather than overwritten.",
            aside.display()
        ),
        Err(e) => log::error!(
            "[secrets] the previous vault could not be opened ({why}) and could not be set aside \
             ({e}); it is about to be replaced."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> MasterKey {
        MasterKey::from_bytes([7u8; KEY_LEN])
    }

    fn other_key() -> MasterKey {
        MasterKey::from_bytes([9u8; KEY_LEN])
    }

    fn sample() -> Map {
        Map::from([
            ("token".to_string(), "t-1".to_string()),
            (
                "nativeAuth:https://gw.example.com".to_string(),
                "{\"access_token\":\"a\"}".to_string(),
            ),
        ])
    }

    #[test]
    fn seal_then_open_round_trips() {
        let map = sample();
        let sealed = seal(&key(), &map).unwrap();

        assert_eq!(open(&key(), &sealed).unwrap(), map);
    }

    #[test]
    fn two_seals_of_the_same_map_differ() {
        // A fixed nonce would be a real break, not a cosmetic one, and it is the
        // kind of thing a refactor can quietly introduce.
        let map = sample();

        assert_ne!(seal(&key(), &map).unwrap(), seal(&key(), &map).unwrap());
    }

    #[test]
    fn open_with_the_wrong_key_is_undecryptable() {
        let sealed = seal(&key(), &sample()).unwrap();

        assert_eq!(open(&other_key(), &sealed), Err(OpenError::Undecryptable));
    }

    #[test]
    fn a_flipped_ciphertext_byte_is_undecryptable() {
        // The whole reason for an AEAD rather than a bare cipher: edited
        // credentials must not read back as credentials.
        let mut sealed = seal(&key(), &sample()).unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;

        assert_eq!(open(&key(), &sealed), Err(OpenError::Undecryptable));
    }

    #[test]
    fn a_flipped_version_byte_is_rejected() {
        let mut sealed = seal(&key(), &sample()).unwrap();
        sealed[MAGIC.len()] = VERSION + 1;

        assert_eq!(
            open(&key(), &sealed),
            Err(OpenError::UnknownVersion(VERSION + 1))
        );
    }

    #[test]
    fn a_foreign_file_is_malformed_rather_than_undecryptable() {
        let sealed = seal(&key(), &sample()).unwrap();
        let mut foreign = sealed.clone();
        foreign[0] = b'X';

        assert!(matches!(
            open(&key(), &foreign),
            Err(OpenError::Malformed(_))
        ));
    }

    #[test]
    fn a_truncated_file_is_malformed() {
        let sealed = seal(&key(), &sample()).unwrap();

        assert!(matches!(
            open(&key(), &sealed[..HEADER_LEN + 2]),
            Err(OpenError::Malformed(_))
        ));
    }

    #[test]
    fn load_of_an_absent_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();

        assert!(load(&key(), &dir.path().join(FILE_NAME))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn save_then_load_round_trips_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let map = sample();

        save(&key(), &path, &map).unwrap();

        assert_eq!(load(&key(), &path).unwrap(), map);
        assert!(
            !temp_path(&path).exists(),
            "the temp file must be renamed, not left behind"
        );
    }

    #[test]
    fn save_creates_the_directory_it_needs() {
        // The app data dir does not exist on a first launch, and the vault must
        // not be the thing that discovers that the hard way.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(FILE_NAME);

        save(&key(), &path, &sample()).unwrap();

        assert_eq!(load(&key(), &path).unwrap(), sample());
    }

    #[cfg(unix)]
    #[test]
    fn save_creates_a_private_file() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);

        save(&key(), &path, &sample()).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();

        assert_eq!(mode & 0o777, 0o600, "the vault must be owner-only");
    }

    #[test]
    fn save_replaces_an_existing_vault() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);

        save(&key(), &path, &sample()).unwrap();

        let replacement = Map::from([("token".to_string(), "t-2".to_string())]);
        save(&key(), &path, &replacement).unwrap();

        assert_eq!(load(&key(), &path).unwrap(), replacement);
    }

    #[test]
    fn an_unreadable_vault_reads_empty_and_is_set_aside_on_the_next_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);

        std::fs::write(&path, b"not a vault at all").unwrap();

        // Empty rather than an error: the app has to stay usable.
        assert!(load(&key(), &path).unwrap().is_empty());

        save(&key(), &path, &sample()).unwrap();

        assert_eq!(load(&key(), &path).unwrap(), sample());

        let kept: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".unreadable-"))
            .collect();

        assert_eq!(kept.len(), 1, "the old bytes must be kept, not destroyed");
        assert_eq!(
            std::fs::read(kept[0].path()).unwrap(),
            b"not a vault at all"
        );
    }

    #[test]
    fn a_readable_vault_is_never_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);

        save(&key(), &path, &sample()).unwrap();
        save(&key(), &path, &sample()).unwrap();

        let kept = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".unreadable-"))
            .count();

        assert_eq!(kept, 0);
    }

    #[test]
    fn master_key_base64_round_trips() {
        let encoded = key().to_base64();

        // 32 bytes is 44 characters of padded base64 — the shape to eyeball in
        // Keychain Access when checking the one item that should be there.
        assert_eq!(encoded.len(), 44);

        let parsed = MasterKey::from_base64(&encoded).unwrap();
        let sealed = seal(&key(), &sample()).unwrap();

        assert_eq!(open(&parsed, &sealed).unwrap(), sample());
    }

    #[test]
    fn a_short_master_key_is_an_error_not_a_new_key() {
        use base64::Engine as _;

        let short = base64::engine::general_purpose::STANDARD.encode([1u8; 16]);

        assert!(MasterKey::from_base64(&short).is_err());
        assert!(MasterKey::from_base64("not base64 at all!!").is_err());
    }

    #[test]
    fn an_empty_map_round_trips() {
        // What a fresh install writes the first time it clears a credential.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);

        save(&key(), &path, &Map::new()).unwrap();

        assert!(load(&key(), &path).unwrap().is_empty());
    }
}
