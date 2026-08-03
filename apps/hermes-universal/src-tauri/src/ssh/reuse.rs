//! Proving a remote backend is ours, over the tunnel.
//!
//! Ported from `apps/desktop/electron/main.ts:6832-6846` (`sshProbeReuseProof`)
//! and `dashboard-token.ts:56-102` (served-token adoption).
//!
//! Why reuse needs a proof at all: the lockfile says a backend of ours is
//! listening on a remote port, but by the time we tunnel to it that port could
//! belong to something else entirely — the process died and the port was
//! recycled, or another tool bound it. Desktop's comment is explicit that pid
//! liveness alone is insufficient, and it is right: liveness proves *a* process
//! exists, not that the thing answering our tunnel is that process.
//!
//! So the proof is an **authenticated** `GET /api/ssh/ownership` that must echo
//! back the exact spawn nonce from our lockfile. A port squatter cannot produce
//! it, and a stale backend from an older protocol will not.

use std::time::Duration;

use serde::Deserialize;

use super::error::{SshError, SshErrorKind};

/// The protocol version this client speaks. A backend answering with anything
/// else predates a change that makes reattaching unsafe.
pub const PROTOCOL_VERSION: u32 = 1;

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(500);
const READY_TIMEOUT: Duration = Duration::from_secs(45);

/// What the ownership probe concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReuseClassification {
    /// It is ours, and the nonce matches. Reattach.
    AuthenticatedOk,
    /// It answered, but it is not the backend our lockfile describes. Clean up
    /// and respawn — never reattach.
    AuthenticatedStale,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct OwnershipProof {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    ssh_owner_nonce: String,
    #[serde(default)]
    protocol_version: u32,
}

/// Classify a proof body against the nonce we expect.
///
/// Split out from the request so the decision is testable without a server. All
/// three fields must line up: `ok` alone would be satisfied by any Hermes, and
/// the nonce alone would be satisfied by an install too old to honour the rest
/// of the ownership contract.
pub fn classify_proof(body: &str, expected_nonce: &str) -> ReuseClassification {
    let Ok(proof) = serde_json::from_str::<OwnershipProof>(body) else {
        return ReuseClassification::AuthenticatedStale;
    };

    if proof.ok && proof.ssh_owner_nonce == expected_nonce && proof.protocol_version == PROTOCOL_VERSION {
        ReuseClassification::AuthenticatedOk
    } else {
        ReuseClassification::AuthenticatedStale
    }
}

/// Whether an HTTP status means "this is not the backend we think it is".
///
/// 401/403 say our token is not accepted, 404 says the endpoint does not exist.
/// Each means the thing on that port is not ours, so it is a stale record rather
/// than a transport problem to retry.
pub fn status_is_stale(status: u16) -> bool {
    matches!(status, 401 | 403 | 404)
}

/// Ask a backend to prove it is the one our lockfile describes.
pub async fn probe_reuse_proof(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    spawn_nonce: &str,
) -> Result<ReuseClassification, SshError> {
    let response = client
        .get(format!("{base_url}/api/ssh/ownership"))
        .header("X-Hermes-Session-Token", token)
        .timeout(PROBE_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            // A transport failure here is NOT evidence about ownership — the
            // tunnel may simply have blipped. Saying "stale" would destroy a
            // healthy backend, so this stays transient and the caller retries.
            SshError::new(
                SshErrorKind::TransientTransportError,
                format!("Could not verify the existing SSH backend: {e}"),
            )
        })?;

    if status_is_stale(response.status().as_u16()) {
        return Ok(ReuseClassification::AuthenticatedStale);
    }

    let body = response.text().await.map_err(|e| {
        SshError::new(
            SshErrorKind::TransientTransportError,
            format!("Could not read the SSH ownership proof: {e}"),
        )
    })?;

    Ok(classify_proof(&body, spawn_nonce))
}

/// Poll `/api/status` until the backend answers, mirroring `local_backend.rs`'s
/// second readiness stage.
///
/// The log line only says uvicorn bound a port; this says the app behind it is
/// actually serving and accepts our token.
pub async fn wait_for_hermes(client: &reqwest::Client, base_url: &str, token: &str) -> Result<(), SshError> {
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;

    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(SshError::new(
                SshErrorKind::Timeout,
                format!("The remote backend did not become ready within {}s.", READY_TIMEOUT.as_secs()),
            ));
        }

        let ok = client
            .get(format!("{base_url}/api/status"))
            .header("X-Hermes-Session-Token", token)
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);

        if ok {
            return Ok(());
        }

        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }
}

/// Pull the token the dashboard actually injects into its index page.
///
/// Ported from `dashboard-token.ts:38-50`. The minted token is only the *spawn*
/// credential; a backend may serve a different one, and the served token is what
/// authorizes `/api/ws`.
pub fn extract_served_token(html: &str) -> Option<String> {
    let marker = "window.__HERMES_SESSION_TOKEN__";
    let at = html.find(marker)?;
    let rest = &html[at + marker.len()..];

    let quote = rest.find('"')?;
    let after = &rest[quote + 1..];

    // Only whitespace and `=` may sit between the marker and the value; anything
    // else means we matched a different statement that merely mentions it.
    if rest[..quote].chars().any(|c| !c.is_whitespace() && c != '=') {
        return None;
    }

    let mut token = String::new();
    let mut chars = after.chars();

    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Some(token),
            '\\' => token.push(chars.next()?),
            _ => token.push(ch),
        }
    }

    None
}

/// Decide whether a served token belongs to a backend we did not spawn.
///
/// Ported from `dashboard-token.ts:79-81`. With our process still alive, a
/// differing token is benign — our own backend regenerated it. With the process
/// dead, a differing token means something else is answering on that port, and
/// adopting its credential would wire the app to a stranger's backend.
pub fn is_foreign_backend(served: &str, spawned: &str, process_alive: bool) -> bool {
    !served.is_empty() && served != spawned && !process_alive
}

/// Resolve the token to actually use, falling back to the spawn token.
pub async fn resolve_served_token(client: &reqwest::Client, base_url: &str, spawn_token: &str) -> String {
    let served = client
        .get(format!("{base_url}/"))
        .timeout(PROBE_TIMEOUT)
        .send()
        .await
        .ok()
        .map(|r| r.text());

    let Some(body) = served else {
        return spawn_token.to_string();
    };

    // A page we cannot read is not evidence of anything; keep what we minted.
    body.await.ok().as_deref().and_then(extract_served_token).unwrap_or_else(|| spawn_token.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "0123456789abcdef";

    #[test]
    fn a_matching_proof_is_reusable() {
        let body = format!(
            r#"{{"ok":true,"sshOwnerNonce":"{NONCE}","protocolVersion":{PROTOCOL_VERSION}}}"#
        );
        assert_eq!(classify_proof(&body, NONCE), ReuseClassification::AuthenticatedOk);
    }

    #[test]
    fn every_field_must_line_up() {
        // `ok` alone would be satisfied by any Hermes; the nonce alone would be
        // satisfied by an install too old to honour the rest of the contract.
        let cases = [
            r#"{"ok":false,"sshOwnerNonce":"0123456789abcdef","protocolVersion":1}"#,
            r#"{"ok":true,"sshOwnerNonce":"ffffffffffffffff","protocolVersion":1}"#,
            r#"{"ok":true,"sshOwnerNonce":"0123456789abcdef","protocolVersion":2}"#,
            r#"{"ok":true}"#,
            r#"{}"#,
        ];

        for body in cases {
            assert_eq!(
                classify_proof(body, NONCE),
                ReuseClassification::AuthenticatedStale,
                "must not reuse on {body}"
            );
        }
    }

    #[test]
    fn an_unreadable_proof_is_stale_not_a_crash() {
        // Something else answering our tunnel will not return our JSON.
        for body in ["", "not json", "<html>404</html>", "null"] {
            assert_eq!(classify_proof(body, NONCE), ReuseClassification::AuthenticatedStale, "{body}");
        }
    }

    #[test]
    fn auth_and_not_found_statuses_mean_stale() {
        // Our token rejected, or the endpoint absent: either way the thing on
        // that port is not ours.
        for status in [401, 403, 404] {
            assert!(status_is_stale(status), "{status}");
        }
    }

    #[test]
    fn server_and_success_statuses_are_not_stale() {
        // A 500 is a backend having a bad day, not proof of a different backend;
        // classifying it as stale would kill a healthy process.
        for status in [200, 500, 502, 503] {
            assert!(!status_is_stale(status), "{status}");
        }
    }

    #[test]
    fn extracts_the_served_token_from_the_index_page() {
        let html = r#"<script>window.__HERMES_SESSION_TOKEN__ = "abc123";</script>"#;
        assert_eq!(extract_served_token(html).as_deref(), Some("abc123"));

        // No spaces around the assignment.
        let tight = r#"window.__HERMES_SESSION_TOKEN__="def456""#;
        assert_eq!(extract_served_token(tight).as_deref(), Some("def456"));
    }

    #[test]
    fn served_token_extraction_handles_escapes() {
        let html = r#"window.__HERMES_SESSION_TOKEN__ = "a\"b\\c""#;
        assert_eq!(extract_served_token(html).as_deref(), Some(r#"a"b\c"#));
    }

    #[test]
    fn served_token_extraction_returns_none_when_absent() {
        assert_eq!(extract_served_token(""), None);
        assert_eq!(extract_served_token("<html><body>hi</body></html>"), None);
        // An unterminated literal is not a token.
        assert_eq!(extract_served_token(r#"window.__HERMES_SESSION_TOKEN__ = "unclosed"#), None);
    }

    #[test]
    fn served_token_extraction_ignores_a_mere_mention() {
        // A page that talks about the marker without assigning it must not be
        // mined for whatever string happens to follow.
        let html = r#"<p>set window.__HERMES_SESSION_TOKEN__ from your "config" file</p>"#;
        assert_eq!(extract_served_token(html), None);
    }

    #[test]
    fn a_differing_token_is_foreign_only_when_our_process_is_dead() {
        // Alive: our own backend regenerated its token — benign drift.
        assert!(!is_foreign_backend("served", "spawned", true));
        // Dead: something else is answering on that port, and adopting its
        // credential would wire the app to a stranger's backend.
        assert!(is_foreign_backend("served", "spawned", false));
    }

    #[test]
    fn a_matching_token_is_never_foreign() {
        assert!(!is_foreign_backend("same", "same", false));
        assert!(!is_foreign_backend("same", "same", true));
        // Nothing served at all is not evidence of a foreign backend.
        assert!(!is_foreign_backend("", "spawned", false));
    }
}
