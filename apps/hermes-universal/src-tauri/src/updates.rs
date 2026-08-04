//! App update checks (MJX-6).
//!
//! Where the new build comes from depends on how the app was installed, so each
//! target asks a different authority:
//!
//! * desktop  — the GitHub Releases API for this repo; the "download" is the
//!              release asset matching the host OS/arch (we do not self-install:
//!              there is no signing key or update server, so the user gets the
//!              file and runs it).
//! * Android  — the Play Store listing for our own package id, scraped for the
//!              published version; the "download" is a `market://` deep link.
//! * iOS      — the official iTunes Lookup API for our own bundle id; the
//!              "download" is an `itms-apps://` deep link.
//!
//! All of it runs here rather than in JS because the webview CSP is
//! `connect-src 'self' ipc:` — the frontend cannot reach github.com/google.com/
//! apple.com at all — and because that is where the rest of our networking lives
//! (see `transport.rs`).
//!
//! The real implementations sit behind the **off-by-default** `update-checks`
//! cargo feature. A default build compiles the stub below, which reports
//! `source: "disabled"` / no update available — never an error, so the About
//! page renders its plain version-only form.
//!
//! Nothing here is fatal: an unreachable store, a rate-limited API or Play
//! changing its markup all resolve to a well-formed `UpdateStatus` carrying a
//! `reason`, so the UI can say "couldn't check" instead of throwing.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, State};

/// How long a check result stays fresh. The About page checks on mount, so
/// without this every visit would hit the network.
const CACHE_TTL_MS: u64 = 6 * 60 * 60 * 1000;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// Which authority answered: `github` | `play` | `appstore` | `disabled`.
    pub source: String,
    /// The running build's version (from the Tauri package info).
    pub current_version: String,
    /// The published version, when we could read one.
    pub latest_version: Option<String>,
    pub update_available: bool,
    /// What to open to get the update — a release asset URL, `market://…` or
    /// `itms-apps://…`.
    pub download_url: Option<String>,
    /// Human-facing page for the same thing (release page / store listing).
    pub notes_url: Option<String>,
    pub checked_at_ms: u64,
    /// `checks_disabled` | `unreachable` | `unparsed` — absent on success.
    pub reason: Option<String>,
}

/// Last result, so `force: false` can answer from memory (see `CACHE_TTL_MS`).
#[derive(Default)]
pub struct UpdateState(tokio::sync::Mutex<Option<UpdateStatus>>);

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, UpdateState>,
    force: bool,
) -> Result<UpdateStatus, String> {
    let current = app.package_info().version.to_string();

    if !force {
        if let Some(cached) = state.0.lock().await.clone() {
            if now_ms().saturating_sub(cached.checked_at_ms) < CACHE_TTL_MS {
                return Ok(cached);
            }
        }
    }

    // The store identity is the bundle/package id from tauri.conf.json — never
    // hardcoded per platform, so a rename can't silently query the wrong app.
    let identifier = app.config().identifier.clone();
    let status = imp::check(&identifier, &current).await;

    *state.0.lock().await = Some(status.clone());

    Ok(status)
}

/// Open the update destination. Routed through the opener plugin's Rust API for
/// the same reason `open_external` is (lib.rs): a Rust-internal call isn't gated
/// by the opener ACL/scope. Handles the non-http `market://` / `itms-apps://`
/// schemes too; if the OS refuses those (no store app — e.g. a sideloaded build
/// on an Android device without Play), we retry with the https listing.
#[tauri::command]
pub fn update_open_download(
    app: AppHandle,
    url: String,
    fallback: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    match app.opener().open_url(url, None::<&str>) {
        Ok(()) => Ok(()),
        Err(err) => match fallback {
            Some(alt) => app
                .opener()
                .open_url(alt, None::<&str>)
                .map_err(|e| e.to_string()),
            None => Err(err.to_string()),
        },
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A blank result for `source`, stamped now. Callers fill in what they learned.
fn status_for(source: &str, current: &str) -> UpdateStatus {
    UpdateStatus {
        source: source.to_string(),
        current_version: current.to_string(),
        checked_at_ms: now_ms(),
        ..UpdateStatus::default()
    }
}

/// Is `latest` a higher version than `current`?
///
/// Numeric dotted comparison, left to right, missing components read as 0
/// (`1.2` == `1.2.0`), a leading `v` tolerated, and any pre-release/build suffix
/// ignored — so `1.2.3-beta` compares equal to `1.2.3` and does not prompt.
/// Deliberately not a full semver parse: the store version strings are not
/// guaranteed to be semver at all.
///
/// `allow(dead_code)`: only the `update-checks` backends call this, but it stays
/// outside the feature gate so the default build still compiles and tests it.
#[allow(dead_code)]
pub fn is_newer(latest: &str, current: &str) -> bool {
    let latest = version_parts(latest);
    let current = version_parts(current);

    for index in 0..latest.len().max(current.len()) {
        let a = latest.get(index).copied().unwrap_or(0);
        let b = current.get(index).copied().unwrap_or(0);

        if a != b {
            return a > b;
        }
    }

    false
}

#[allow(dead_code)]
fn version_parts(value: &str) -> Vec<u64> {
    value
        .trim()
        .trim_start_matches(['v', 'V'])
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .collect()
}

// --------------------------------------------------------------------------
// Real checks — `--features update-checks`.
// --------------------------------------------------------------------------
#[cfg(feature = "update-checks")]
mod imp {
    use std::time::Duration;

    use super::{is_newer, status_for, UpdateStatus};

    const TIMEOUT: Duration = Duration::from_secs(10);
    /// GitHub rejects requests without a User-Agent.
    const API_USER_AGENT: &str = concat!("Hermes-Universal/", env!("CARGO_PKG_VERSION"));
    /// Play serves a different (parseable) page to a browser-shaped agent.
    /// (Android-only, like `GITHUB_LATEST` is desktop-only — hence the allows.)
    #[allow(dead_code)]
    const WEB_USER_AGENT: &str =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

    #[allow(dead_code)]
    const GITHUB_LATEST: &str =
        "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest";

    const REASON_UNREACHABLE: &str = "unreachable";
    const REASON_UNPARSED: &str = "unparsed";

    /// A dedicated client, NOT `TransportState`'s — that one carries the gateway
    /// session cookie jar, which must never be sent to GitHub/Google/Apple.
    async fn get(url: &str, accept: &str, user_agent: &str) -> Option<String> {
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(user_agent)
            .build()
            .ok()?;

        let response = client.get(url).header("Accept", accept).send().await.ok()?;

        if !response.status().is_success() {
            return None;
        }

        response.text().await.ok()
    }

    // ---- desktop: GitHub Releases ----------------------------------------
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub async fn check(_identifier: &str, current: &str) -> UpdateStatus {
        let mut status = status_for("github", current);

        let Some(body) = get(GITHUB_LATEST, "application/vnd.github+json", API_USER_AGENT).await
        else {
            status.reason = Some(REASON_UNREACHABLE.to_string());

            return status;
        };

        let Some(release) = parse_github(&body) else {
            status.reason = Some(REASON_UNPARSED.to_string());

            return status;
        };

        status.update_available = is_newer(&release.version, current);
        status.latest_version = Some(release.version);
        status.notes_url = Some(release.notes_url.clone());
        status.download_url = Some(release.download_url.unwrap_or(release.notes_url));

        status
    }

    // ---- Android: Play Store listing --------------------------------------
    #[cfg(target_os = "android")]
    pub async fn check(identifier: &str, current: &str) -> UpdateStatus {
        let mut status = status_for("play", current);
        let listing = format!("https://play.google.com/store/apps/details?id={identifier}&hl=en&gl=US");

        status.notes_url = Some(listing.clone());
        status.download_url = Some(format!("market://details?id={identifier}"));

        let Some(body) = get(&listing, "text/html", WEB_USER_AGENT).await else {
            status.reason = Some(REASON_UNREACHABLE.to_string());

            return status;
        };

        // Scraping a listing page is inherently brittle — Google changes this
        // markup without notice. A miss is "we don't know", not an error.
        let Some(version) = parse_play(&body) else {
            status.reason = Some(REASON_UNPARSED.to_string());

            return status;
        };

        status.update_available = is_newer(&version, current);
        status.latest_version = Some(version);

        status
    }

    // ---- iOS: iTunes Lookup API -------------------------------------------
    #[cfg(target_os = "ios")]
    pub async fn check(identifier: &str, current: &str) -> UpdateStatus {
        let mut status = status_for("appstore", current);
        let lookup = format!("https://itunes.apple.com/lookup?bundleId={identifier}&country=us");

        let Some(body) = get(&lookup, "application/json", API_USER_AGENT).await else {
            status.reason = Some(REASON_UNREACHABLE.to_string());

            return status;
        };

        // An app that isn't on the store yet returns resultCount: 0 — same
        // "we don't know" shape as a parse miss.
        let Some((version, track_url)) = parse_itunes(&body) else {
            status.reason = Some(REASON_UNPARSED.to_string());

            return status;
        };

        status.update_available = is_newer(&version, current);
        status.latest_version = Some(version);
        // itms-apps:// opens the App Store app directly instead of Safari.
        status.download_url = Some(track_url.replacen("https://", "itms-apps://", 1));
        status.notes_url = Some(track_url);

        status
    }

    // ------------------------------------------------------------------
    // Parsers. Deliberately target-independent (only the `check` dispatch
    // above is `cfg`-gated) so all three are compiled and unit-tested on the
    // dev host — the mobile ones would otherwise never be exercised.
    // ------------------------------------------------------------------

    pub struct GithubRelease {
        pub version: String,
        pub notes_url: String,
        pub download_url: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct GithubReleaseJson {
        tag_name: String,
        html_url: String,
        #[serde(default)]
        assets: Vec<GithubAssetJson>,
    }

    #[derive(serde::Deserialize)]
    struct GithubAssetJson {
        name: String,
        browser_download_url: String,
    }

    /// Installer extensions for the host OS, most-preferred first.
    fn asset_suffixes() -> &'static [&'static str] {
        #[cfg(target_os = "macos")]
        {
            &[".dmg", ".app.tar.gz"]
        }
        #[cfg(target_os = "windows")]
        {
            &[".msi", "-setup.exe", ".exe"]
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            &[".appimage", ".deb", ".rpm"]
        }
    }

    #[allow(dead_code)]
    pub fn parse_github(body: &str) -> Option<GithubRelease> {
        let release: GithubReleaseJson = serde_json::from_str(body).ok()?;
        let version = release.tag_name.trim().trim_start_matches(['v', 'V']).to_string();

        if version.is_empty() {
            return None;
        }

        // Prefer an asset that also names this architecture (a release carries
        // both aarch64 and x86_64 builds); otherwise take the first match.
        let arch = std::env::consts::ARCH;
        let mut download_url = None;

        for suffix in asset_suffixes() {
            let matching: Vec<&GithubAssetJson> = release
                .assets
                .iter()
                .filter(|asset| asset.name.to_ascii_lowercase().ends_with(suffix))
                .collect();

            if matching.is_empty() {
                continue;
            }

            let chosen = matching
                .iter()
                .find(|asset| asset.name.to_ascii_lowercase().contains(arch))
                .unwrap_or(&matching[0]);

            download_url = Some(chosen.browser_download_url.clone());
            break;
        }

        Some(GithubRelease {
            version,
            notes_url: release.html_url,
            download_url,
        })
    }

    /// Pull the published version out of a Play listing page. Ordered by how
    /// stable each shape has proven: the `[[["1.2.3"]]]` blob in the embedded
    /// data callback, the schema.org `softwareVersion` field, then the visible
    /// "Current Version" label.
    #[allow(dead_code)]
    pub fn parse_play(body: &str) -> Option<String> {
        use std::sync::OnceLock;

        use regex::Regex;

        static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();

        let patterns = PATTERNS.get_or_init(|| {
            [
                r#"\[\[\["(\d+(?:\.\d+)+[^"]*)"\]\]"#,
                r#""softwareVersion"\s*:\s*"(\d+(?:\.\d+)*[^"]*)""#,
                r#"(?s)Current Version.{0,200}?>\s*(\d+(?:\.\d+)+)\s*<"#,
            ]
            .iter()
            .filter_map(|pattern| Regex::new(pattern).ok())
            .collect()
        });

        for pattern in patterns {
            if let Some(captures) = pattern.captures(body) {
                let value = captures.get(1)?.as_str().trim();

                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }

        None
    }

    #[derive(serde::Deserialize)]
    struct ItunesLookup {
        #[serde(default)]
        results: Vec<ItunesResult>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ItunesResult {
        #[serde(default)]
        version: String,
        #[serde(default)]
        track_view_url: String,
    }

    /// `(version, storeUrl)` from an iTunes Lookup response. An app that isn't
    /// published yet answers `resultCount: 0`, which lands here as `None`.
    #[allow(dead_code)]
    pub fn parse_itunes(body: &str) -> Option<(String, String)> {
        let lookup: ItunesLookup = serde_json::from_str(body).ok()?;
        let first = lookup.results.into_iter().next()?;
        let version = first.version.trim().to_string();

        if version.is_empty() {
            return None;
        }

        Some((version, first.track_view_url))
    }
}

// --------------------------------------------------------------------------
// Stub — the default build. Same signature, so everything above is identical
// either way and `generate_handler!` never changes shape.
// --------------------------------------------------------------------------
#[cfg(not(feature = "update-checks"))]
mod imp {
    use super::{status_for, UpdateStatus};

    pub async fn check(_identifier: &str, current: &str) -> UpdateStatus {
        let mut status = status_for("disabled", current);

        status.reason = Some("checks_disabled".to_string());

        status
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("1.2.4", "1.2.3"));
        assert!(is_newer("1.3.0", "1.2.9"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(is_newer("1.2.3", "1.2"));
        assert!(is_newer("0.0.2", "0.0.1"));
    }

    #[test]
    fn is_not_newer_when_same_or_older() {
        assert!(!is_newer("1.2.3", "1.2.3"));
        assert!(!is_newer("1.2", "1.2.0"));
        assert!(!is_newer("1.2.3", "1.2.4"));
        assert!(!is_newer("0.9.9", "1.0.0"));
    }

    #[test]
    fn tolerates_v_prefix_and_suffixes() {
        assert!(is_newer("v1.2.4", "1.2.3"));
        assert!(!is_newer("1.2.3-beta.1", "1.2.3"));
        assert!(is_newer("1.2.4-rc1", "1.2.3"));
        assert!(!is_newer("", "1.0.0"));
    }
}

#[cfg(all(test, feature = "update-checks"))]
mod backend_tests {
    use super::imp::{parse_github, parse_itunes, parse_play};

    #[test]
    fn reads_a_github_release() {
        let body = r#"{
            "tag_name": "v1.4.0",
            "html_url": "https://github.com/NousResearch/hermes-agent/releases/tag/v1.4.0",
            "assets": [
                {"name": "Hermes_1.4.0_amd64.deb", "browser_download_url": "https://example.test/deb"},
                {"name": "Hermes_1.4.0_x86_64.AppImage", "browser_download_url": "https://example.test/x86"},
                {"name": "Hermes_1.4.0_aarch64.AppImage", "browser_download_url": "https://example.test/arm"}
            ]
        }"#;

        let release = parse_github(body).expect("parsed");

        assert_eq!(release.version, "1.4.0");
        assert!(release.notes_url.ends_with("v1.4.0"));
        // Which asset wins depends on the host, but it must be one of them.
        assert!(release.download_url.is_some());
    }

    #[test]
    fn falls_back_to_the_release_page_without_assets() {
        let body = r#"{"tag_name": "1.0.0", "html_url": "https://example.test/rel", "assets": []}"#;
        let release = parse_github(body).expect("parsed");

        assert_eq!(release.download_url, None);
        assert_eq!(release.notes_url, "https://example.test/rel");
    }

    #[test]
    fn rejects_unparseable_github_payloads() {
        assert!(parse_github("not json").is_none());
        assert!(parse_github(r#"{"tag_name": "", "html_url": "x"}"#).is_none());
    }

    #[test]
    fn reads_the_play_version_blob() {
        let body = r#"…,[[["2.7.1"]],[[["Aug 1, 2026"]]],…"#;

        assert_eq!(parse_play(body).as_deref(), Some("2.7.1"));
    }

    #[test]
    fn reads_the_play_software_version_field() {
        let body = r#"{"@type":"SoftwareApplication","softwareVersion":"3.0.4"}"#;

        assert_eq!(parse_play(body).as_deref(), Some("3.0.4"));
    }

    #[test]
    fn returns_none_when_play_markup_changes() {
        assert!(parse_play("<html><body>nothing useful here</body></html>").is_none());
    }

    #[test]
    fn reads_an_itunes_lookup() {
        let body = r#"{"resultCount":1,"results":[{"version":"5.2.0","trackViewUrl":"https://apps.apple.com/us/app/hermes/id123"}]}"#;
        let (version, url) = parse_itunes(body).expect("parsed");

        assert_eq!(version, "5.2.0");
        assert_eq!(url, "https://apps.apple.com/us/app/hermes/id123");
    }

    #[test]
    fn returns_none_for_an_unlisted_app() {
        assert!(parse_itunes(r#"{"resultCount":0,"results":[]}"#).is_none());
        assert!(parse_itunes("nope").is_none());
    }
}
