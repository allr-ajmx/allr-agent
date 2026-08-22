//! Whether the running bundle carries a code signature the OS keychain can bind to.
//!
//! This module exists because of one user-visible failure that is otherwise
//! impossible to diagnose from inside the app: the login keychain asking for a
//! password over and over, several times per launch.
//!
//! macOS binds each keychain item's ACL to the *designated requirement* of the
//! code requesting it. A Developer ID signed bundle has a stable one, so "Always
//! Allow" sticks. An ad-hoc (or linker-signed) bundle has no sealed signature and
//! no internal requirements at all, so there is nothing for the ACL to trust —
//! every read AND every write re-prompts, and reads and writes are separate ACL
//! operations, so allowing one does not cover the other.
//!
//! The app cannot fix that at runtime. What it can do is stop the user guessing:
//! the answer is "this build was not signed", and it belongs in a log line and in
//! `secrets_status` rather than in a support thread.
//!
//! ## Why a file check and not the Security framework
//!
//! `SecCodeCopySigningInformation` would answer this more precisely, at the cost
//! of a new dependency and an unsafe FFI block for a value that only ever drives
//! an explanatory message. The cheap check is exact enough for the distinction
//! that matters: a sealed signature writes `Contents/_CodeSignature/CodeResources`
//! into the bundle, and an ad-hoc linker-signed one writes no `_CodeSignature`
//! directory at all (`codesign -dv` reports `Sealed Resources=none`). Verified
//! against both a Developer ID app and one of our own ad-hoc releases.
//!
//! It deliberately does NOT try to distinguish a valid signature from a broken or
//! revoked one. That is Gatekeeper's job, it needs real verification to answer,
//! and it is not the question being asked here.

/// What the OS can make of this build's identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeIdentity {
    /// A sealed signature is present. Keychain ACLs can bind to it, so the user
    /// is prompted at most once per item.
    Sealed,
    /// No sealed signature: ad-hoc, linker-signed, or unsigned. Expect a keychain
    /// password dialog on every credential access.
    AdHoc,
    /// Not running from an app bundle at all — `tauri dev`, a test binary, or a
    /// platform where the question does not arise. Says nothing either way.
    Unbundled,
}

impl CodeIdentity {
    /// Whether this identity is the one that causes repeated keychain prompts.
    ///
    /// `Unbundled` is not: a dev build stores credentials under whatever identity
    /// the binary happens to have, and telling a developer their build is
    /// "unsigned" during `tauri dev` is noise, not a diagnosis.
    pub fn prompts_on_every_keychain_access(self) -> bool {
        matches!(self, Self::AdHoc)
    }
}

/// Inspect the running bundle.
///
/// Answers `Unbundled` on every non-macOS target: this failure mode is specific
/// to how the macOS login keychain authorizes access, and inventing an answer for
/// platforms whose credential stores work differently would be a lie the UI would
/// then repeat.
pub fn current() -> CodeIdentity {
    #[cfg(not(target_os = "macos"))]
    {
        CodeIdentity::Unbundled
    }

    #[cfg(target_os = "macos")]
    {
        let Ok(exe) = std::env::current_exe() else {
            return CodeIdentity::Unbundled;
        };

        // <bundle>.app/Contents/MacOS/<exe> — so `Contents` is two levels up.
        // Checked by NAME rather than assumed, so a bare binary that merely
        // happens to sit two directories deep is not read as a bundle.
        let Some(contents) = exe.parent().and_then(|macos| macos.parent()) else {
            return CodeIdentity::Unbundled;
        };

        if contents.file_name().and_then(|n| n.to_str()) != Some("Contents") {
            return CodeIdentity::Unbundled;
        }

        if contents
            .join("_CodeSignature")
            .join("CodeResources")
            .exists()
        {
            CodeIdentity::Sealed
        } else {
            CodeIdentity::AdHoc
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The distinction the UI copy turns on. `Unbundled` must not be reported as
    /// the ad-hoc problem, or every dev build would carry a warning about a
    /// release-only failure.
    #[test]
    fn only_an_ad_hoc_bundle_is_blamed_for_the_prompts() {
        assert!(CodeIdentity::AdHoc.prompts_on_every_keychain_access());
        assert!(!CodeIdentity::Sealed.prompts_on_every_keychain_access());
        assert!(!CodeIdentity::Unbundled.prompts_on_every_keychain_access());
    }

    /// The test binary is not an app bundle, so this must answer `Unbundled`
    /// rather than mistaking `target/debug/deps/` for one.
    #[test]
    fn a_test_binary_is_not_mistaken_for_a_bundle() {
        assert_eq!(current(), CodeIdentity::Unbundled);
    }
}
