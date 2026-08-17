//! Getting hold of the install script for a chosen repo.
//!
//! Mirrors `apps/bootstrap-installer/src-tauri/src/install_script.rs` and
//! Electron's `resolveInstallScript`: a dev checkout wins, otherwise fetch the
//! script from the repo's raw URL and cache it.
//!
//! The repo is chosen from a CLOSED SET on this side of the IPC boundary. The
//! webview names `Repo::Upstream` or `Repo::Fork`; it never supplies a URL. A URL
//! from the webview would become a `git clone` target and a script we execute —
//! remote code execution with extra steps.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Which Hermes to install.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Repo {
    /// The official project.
    Upstream,
    /// The fork used for testing experimental features.
    Fork,
}

impl Repo {
    /// `owner/name`, used for both the clone URL and the raw-content URL so the
    /// script and the tree it clones can never come from different repos.
    pub fn slug(self) -> &'static str {
        match self {
            Self::Upstream => "NousResearch/hermes-agent",
            Self::Fork => "jaxmatrix/mjx-hermes-agent",
        }
    }

    pub fn clone_url(self) -> String {
        format!("https://github.com/{}.git", self.slug())
    }

    /// HTTPS only. The install scripts try SSH first, but an app-driven install
    /// must never surface a host-key prompt or a FIDO2 touch request into a GUI
    /// that has nowhere to show it.
    pub fn raw_script_url(self, branch: &str, name: &str) -> String {
        format!(
            "https://raw.githubusercontent.com/{}/{}/scripts/{}",
            self.slug(),
            branch,
            name
        )
    }

    pub fn cache_key(self) -> &'static str {
        match self {
            Self::Upstream => "upstream",
            Self::Fork => "fork",
        }
    }
}

/// `install.sh` everywhere but Windows.
pub fn script_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "install.ps1"
    } else {
        "install.sh"
    }
}

/// Only `[A-Za-z0-9._-]` survives, so a branch like `feat/x` cannot climb out of
/// the cache directory when it is pasted into a filename.
pub fn sanitize_ref(reference: &str) -> String {
    let cleaned: String = reference
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();

    if cleaned.is_empty() {
        "main".to_string()
    } else {
        cleaned
    }
}

pub fn cache_path(hermes_home: &Path, repo: Repo, reference: &str) -> PathBuf {
    hermes_home.join("bootstrap-cache").join(format!(
        "install-{}-{}.{}",
        repo.cache_key(),
        sanitize_ref(reference),
        if cfg!(target_os = "windows") {
            "ps1"
        } else {
            "sh"
        }
    ))
}

// NOT desktop-gated, unlike the rest of local_install: the SSH gateway installs
// Hermes on a REMOTE host, and that works from a phone too (russh is pure Rust —
// see the ssh module's note on why there is no SSH_MODE_SUPPORTED). Fetching the
// script is plain HTTP plus a file write, with nothing desktop-specific in it.
pub use imp::resolve;

mod imp {
    use std::path::{Path, PathBuf};

    use super::{cache_path, script_name, Repo};

    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

    /// A checked-out repo next to the running app, for `tauri dev`.
    ///
    /// Same intent as `resolveInstallScript` tier 1: a developer editing
    /// `scripts/install.sh` should be running their edit, not last week's copy
    /// from GitHub.
    fn dev_checkout_script() -> Option<PathBuf> {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        // src-tauri → hermes-universal → apps → repo root
        let candidate = manifest
            .parent()?
            .parent()?
            .parent()?
            .join("scripts")
            .join(script_name());

        candidate.is_file().then_some(candidate)
    }

    /// The install script for `repo`@`branch`, as a path on disk.
    ///
    /// A fresh reqwest client, NOT the app's `TransportState` one: that carries
    /// the gateway session cookie jar, which must never be sent to GitHub. The
    /// same reasoning is spelled out in `updates.rs`.
    pub async fn resolve(
        hermes_home: &Path,
        repo: Repo,
        branch: &str,
        dev_override: bool,
    ) -> Result<PathBuf, String> {
        if dev_override {
            if let Some(path) = dev_checkout_script() {
                return Ok(path);
            }
        }

        let destination = cache_path(hermes_home, repo, branch);
        let url = repo.raw_script_url(branch, script_name());

        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!("Hermes-Universal/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("could not build an HTTP client: {e}"))?;

        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("could not download the install script from {url}: {e}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "could not download the install script from {url}: HTTP {}",
                response.status()
            ));
        }

        let body = response
            .bytes()
            .await
            .map_err(|e| format!("could not read the install script from {url}: {e}"))?;

        if body.is_empty() {
            return Err(format!("the install script at {url} was empty"));
        }

        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create the script cache directory: {e}"))?;
        }

        // tmp + rename, so a download killed halfway cannot leave a truncated
        // script behind for the next run to execute.
        let temporary = destination.with_extension("tmp");

        std::fs::write(&temporary, &body)
            .map_err(|e| format!("could not write the install script: {e}"))?;
        std::fs::rename(&temporary, &destination)
            .map_err(|e| format!("could not finalize the install script: {e}"))?;

        Ok(destination)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_repo_has_one_identity_behind_both_urls() {
        // The script and the tree it clones must come from the same repo — a
        // fork's install script cloning upstream would be silently wrong.
        for repo in [Repo::Upstream, Repo::Fork] {
            let slug = repo.slug();

            assert!(repo.clone_url().contains(slug));
            assert!(repo.raw_script_url("main", "install.sh").contains(slug));
        }
    }

    #[test]
    fn the_fork_points_at_the_fork() {
        assert_eq!(Repo::Fork.slug(), "jaxmatrix/mjx-hermes-agent");
        assert_eq!(Repo::Upstream.slug(), "NousResearch/hermes-agent");
    }

    #[test]
    fn clone_and_script_urls_are_https() {
        // Never SSH: a GUI install has nowhere to show a host-key prompt or a
        // hardware-key touch request.
        for repo in [Repo::Upstream, Repo::Fork] {
            assert!(repo.clone_url().starts_with("https://"));
            assert!(repo
                .raw_script_url("main", "install.sh")
                .starts_with("https://"));
        }
    }

    #[test]
    fn a_branch_name_cannot_escape_the_cache_directory() {
        assert_eq!(sanitize_ref("feat/thing"), "feat-thing");
        assert_eq!(sanitize_ref("main"), "main");
        assert_eq!(sanitize_ref(""), "main");

        // Dots survive (they are legal in a ref), so the traversal defence is
        // the absence of separators plus the `install-<repo>-` prefix, which
        // means the ref can never BE `..`.
        let traversal = sanitize_ref("../../etc/passwd");

        assert!(!traversal.contains('/'), "{traversal}");
        assert!(!traversal.contains('\\'), "{traversal}");

        let path = cache_path(Path::new("/tmp/home"), Repo::Fork, "../escape");

        assert_eq!(path.parent(), Some(Path::new("/tmp/home/bootstrap-cache")));
        assert!(path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("install-fork-")));
    }

    #[test]
    fn the_cache_key_separates_the_two_repos() {
        let upstream = cache_path(Path::new("/h"), Repo::Upstream, "main");
        let fork = cache_path(Path::new("/h"), Repo::Fork, "main");

        // Same branch, different repo — one must not serve the other's script.
        assert_ne!(upstream, fork);
    }

    #[test]
    fn the_script_matches_the_platform() {
        if cfg!(target_os = "windows") {
            assert_eq!(script_name(), "install.ps1");
        } else {
            assert_eq!(script_name(), "install.sh");
        }
    }
}
