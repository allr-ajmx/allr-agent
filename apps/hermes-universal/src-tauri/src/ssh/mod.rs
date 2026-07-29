//! SSH gateway transport (MJX-55).
//!
//! Reaches a Hermes backend on a remote host over SSH. The shape, ported from the
//! Electron desktop app (`apps/desktop/electron/{ssh-connection,remote-lifecycle,
//! windows-remote-lifecycle}.ts`):
//!
//!   1. Dial the host as an SSH *client*. Nothing listens on port 22 here — 22 is
//!      the destination, and the gateway protocol is never piped over stdio.
//!   2. Run control-plane `exec` channels to probe the platform, locate `hermes`,
//!      check its capabilities, read/write a lockfile, and upload a session token
//!      over stdin (never argv).
//!   3. Spawn `hermes serve --isolated --host 127.0.0.1 --port 0` detached on the
//!      remote and scrape `HERMES_(BACKEND|DASHBOARD)_READY port=<N>` from its log.
//!      It binds remote loopback only — the tunnel is the sole route in.
//!   4. Forward a local `127.0.0.1:<ephemeral>` TCP port to that remote port. The
//!      ordinary HTTP + `/api/ws` traffic then rides that forward, so the rest of
//!      the app just sees a token-authed backend on loopback.
//!   5. On reconnect, reuse the still-running remote backend via the lockfile plus
//!      an authenticated `GET /api/ssh/ownership` nonce proof. Teardown drops the
//!      tunnel, NOT the remote backend.
//!
//! Unlike `local_backend.rs`, nothing in this module is `#[cfg(desktop)]`-gated.
//! russh is pure Rust and cross-compiles to the mobile targets, which is the whole
//! reason we do not shell out to the system `ssh` binary — see the `russh`
//! dependency comment in Cargo.toml.
//!
//! Steps 1, 2 and 4 above are live; the lifecycle that drives steps 3 and 5
//! (`posix_lifecycle` / `windows_lifecycle`) is still pure-only and is wired up
//! next.

// The lifecycle halves have no callers until the connect command lands. Without
// this, every item there is reported as dead code and the real warnings drown.
// Remove once `ssh_connect` is wired.
#![allow(dead_code)]

pub mod auth;
pub mod config;
pub mod error;
pub mod forward;
pub mod known_hosts;
pub mod ownership;
pub mod posix_lifecycle;
pub mod progress;
pub mod prompt;
pub mod remote_paths;
pub mod session;
pub mod target;
pub mod windows_lifecycle;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot, Mutex};

use auth::Credentials;
use error::{SshError, SshErrorKind};
use known_hosts::{HostKeyPolicy, HostKeyPrompt};
use progress::{ProgressReporter, SshStep};
use prompt::{ChannelPrompter, NoPrompter, PromptKind, PromptRequest, Prompter};
use session::{ConnectOptions, SshSession, DEFAULT_CONNECT_TIMEOUT};
use target::{normalize_ssh_target, SshTargetInput};

/// What the frontend sends to open or test a connection.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectConfig {
    #[serde(flatten)]
    pub target: SshTargetInput,
    /// Which gateway profile this connection is for. Also the ownership scope,
    /// so two profiles never share one remote backend.
    #[serde(default)]
    pub profile: Option<String>,
    /// A PEM held in the OS keyring. The mobile route — there is no usable
    /// private-key file picker on Android or iOS.
    #[serde(default)]
    pub private_key_pem: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    /// Whether the caller can answer prompts. False for a boot restore, which
    /// runs before any UI is mounted.
    #[serde(default)]
    pub interactive: bool,
}

/// The result of a reachability check.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResult {
    pub reachable: bool,
    pub host_label: String,
    /// `uname -s` from the remote, when we got that far.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
}

/// What `ssh_resolve_host` reports back, so the settings form can show what
/// `~/.ssh/config` actually resolved to rather than leaving the user guessing.
#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshResolvedHost {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    /// Directives we parsed but do not act on. Surfaced rather than swallowed:
    /// silently ignoring a ProxyJump would connect somewhere the user did not
    /// ask for.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unsupported: Vec<String>,
}

/// A connect attempt in flight, and the channels its prompts arrive on.
struct Attempt {
    cancel: tokio_util::sync::CancellationToken,
    /// Pending questions, keyed by prompt id, awaiting `ssh_answer_prompt`.
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
    /// Pending host-key decisions, awaiting `ssh_trust_host_key`.
    pending_host_key: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
}

/// Live sessions and in-flight attempts, held in Tauri managed state.
///
/// This is what replaces desktop's on-disk control socket. Nothing about a
/// session outlives the process, so there is no stale-master problem to detect
/// or evict.
#[derive(Default)]
pub struct SshState {
    sessions: Mutex<HashMap<String, Arc<SshSession>>>,
    attempts: Mutex<HashMap<String, Arc<Attempt>>>,
}

/// The scope key for a connection. An empty profile is the default scope.
fn scope_of(profile: Option<&str>) -> String {
    profile.unwrap_or("").to_string()
}

/// The user's home directory, if there is one. Mobile has none, and every caller
/// treats that as "no `~/.ssh` to read" rather than as an error.
fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Android reports a HOME, but it is an app-private sandbox with no
        // ~/.ssh in it. Treating it as absent keeps the mobile path honest.
        if cfg!(target_os = "android") || cfg!(target_os = "ios") {
            return None;
        }

        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

/// Where to record trusted host keys.
fn known_hosts_path(app: &AppHandle) -> Result<PathBuf, SshError> {
    let app_data = app.path().app_data_dir().ok();

    known_hosts::store_path(home_dir().as_deref(), app_data.as_deref()).ok_or_else(|| {
        SshError::new(SshErrorKind::Unknown, "No writable location for the known-hosts store.")
    })
}

/// Resolve the settings-form target against `~/.ssh/config`, then decide the
/// user to log in as.
///
/// Precedence matches OpenSSH: an explicit value beats the config file, which
/// beats the local username.
fn resolve_target(
    input: &SshTargetInput,
) -> Result<(target::SshTarget, String, Credentials), SshError> {
    let Some(mut target) = normalize_ssh_target(input)? else {
        return Err(SshError::new(SshErrorKind::Unknown, "An SSH host is required."));
    };

    let home = home_dir();
    let resolved = config::default_config_path(home.as_deref())
        .map(|path| config::resolve_host(&target.host, &path, home.as_deref(), &config::FsConfigReader))
        .unwrap_or_default();

    // Refuse rather than quietly connect direct: a Host the user expects to be
    // reachable only through a bastion would otherwise resolve to a different
    // machine entirely.
    if resolved.requires_unsupported_proxy() {
        return Err(SshError::new(
            SshErrorKind::UnsupportedPlatform,
            format!(
                "{} is configured with ProxyJump/ProxyCommand in ~/.ssh/config, which is not supported yet. \
                 Connect to the jump host's target directly, or remove the directive.",
                target.host
            ),
        ));
    }

    if let Some(hostname) = resolved.hostname.clone() {
        target.host = hostname;
    }

    if target.port.is_none() {
        target.port = resolved.port;
    }

    let user = target
        .user
        .clone()
        .or_else(|| resolved.user.clone())
        .or_else(|| std::env::var("USER").ok())
        .or_else(|| std::env::var("USERNAME").ok())
        .unwrap_or_else(|| "root".to_string());

    let credentials = Credentials {
        key_path: target.key_path.clone(),
        identity_file: resolved.identity_file.clone(),
        ..Default::default()
    };

    Ok((target, user, credentials))
}

/// Build the prompt plumbing for one attempt, and register it so
/// `ssh_answer_prompt` / `ssh_trust_host_key` can route answers back.
async fn arm_prompts(
    app: &AppHandle,
    state: &SshState,
    attempt_id: &str,
    interactive: bool,
) -> (Box<dyn Prompter>, Arc<HostKeyPolicy>, Arc<Attempt>) {
    let attempt = Arc::new(Attempt {
        cancel: tokio_util::sync::CancellationToken::new(),
        pending: Arc::new(Mutex::new(HashMap::new())),
        pending_host_key: Arc::new(Mutex::new(None)),
    });

    state.attempts.lock().await.insert(attempt_id.to_string(), Arc::clone(&attempt));

    if !interactive {
        // A boot restore has no UI to answer with. Trust-on-first-use still
        // applies (that is what desktop did), but nothing may block on a person.
        return (Box::new(NoPrompter), Arc::new(HostKeyPolicy::AcceptNew), attempt);
    }

    let (prompt_tx, prompt_rx) = mpsc::channel::<PromptRequest>(4);
    let (host_key_tx, host_key_rx) = mpsc::channel::<HostKeyPrompt>(1);

    tokio::spawn(forward_prompts(app.clone(), attempt_id.to_string(), Arc::clone(&attempt), prompt_rx));
    tokio::spawn(forward_host_key_prompts(
        app.clone(),
        attempt_id.to_string(),
        Arc::clone(&attempt),
        host_key_rx,
    ));

    (Box::new(ChannelPrompter::new(prompt_tx)), Arc::new(HostKeyPolicy::Ask(host_key_tx)), attempt)
}

/// What the UI receives when the connect needs an answer.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct PromptEvent {
    prompt_id: String,
    kind: PromptKind,
    label: String,
    secret: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct HostKeyEvent {
    host: String,
    port: u16,
    fingerprint: String,
}

/// Relay credential prompts to the UI and park the responder.
async fn forward_prompts(
    app: AppHandle,
    attempt_id: String,
    attempt: Arc<Attempt>,
    mut rx: mpsc::Receiver<PromptRequest>,
) {
    use tauri::Emitter;

    let mut counter: u64 = 0;

    while let Some(request) = rx.recv().await {
        counter += 1;
        let prompt_id = format!("{attempt_id}-{counter}");

        attempt.pending.lock().await.insert(prompt_id.clone(), request.respond);

        let payload = PromptEvent {
            prompt_id,
            kind: request.kind,
            label: request.label,
            secret: request.kind.is_secret(),
        };

        // A failed emit leaves the responder parked; the prompt's own timeout
        // then releases it rather than hanging the attempt forever.
        let _ = app.emit(&format!("ssh://{attempt_id}/prompt"), payload);
    }
}

/// Relay host-key trust questions to the UI.
async fn forward_host_key_prompts(
    app: AppHandle,
    attempt_id: String,
    attempt: Arc<Attempt>,
    mut rx: mpsc::Receiver<HostKeyPrompt>,
) {
    use tauri::Emitter;

    while let Some(request) = rx.recv().await {
        *attempt.pending_host_key.lock().await = Some(request.respond);

        let payload =
            HostKeyEvent { host: request.host, port: request.port, fingerprint: request.fingerprint };

        let _ = app.emit(&format!("ssh://{attempt_id}/host-key"), payload);
    }
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

/// Check that a host is reachable, authenticates, and runs a supported OS.
///
/// Opens a throwaway session and drops it. Desktop achieved the same isolation
/// with `createSshProbeConnection(config, {mux: false})` so a test could never
/// poison the live ControlMaster; we have no master to poison, but sharing the
/// live session would still mean a failed test could tear down a working
/// connection. Keep this separate.
#[tauri::command]
pub async fn ssh_test(
    app: AppHandle,
    state: State<'_, SshState>,
    attempt_id: String,
    config: SshConnectConfig,
) -> Result<SshTestResult, SshError> {
    let reporter = ProgressReporter::new(app.clone(), &attempt_id);
    let (target, user, mut credentials) = resolve_target(&config.target)?;

    credentials.private_key_pem = config.private_key_pem.clone();
    credentials.passphrase = config.passphrase.clone();
    credentials.password = config.password.clone();

    let (prompter, policy, _attempt) = arm_prompts(&app, &state, &attempt_id, config.interactive).await;
    let known_hosts_path = known_hosts_path(&app)?;

    reporter.step(SshStep::Connecting);

    let options = ConnectOptions {
        credentials,
        policy,
        known_hosts_path,
        home: home_dir(),
        connect_timeout: DEFAULT_CONNECT_TIMEOUT,
    };

    let host_label = target.label();
    let result = async {
        let session = SshSession::open(target, user, options, prompter.as_ref()).await?;

        reporter.step(SshStep::ProbingPlatform);
        let uname = session.exec("uname -s; uname -m", None).await?.require_success("uname")?;

        let mut lines = uname.lines().map(str::trim).filter(|l| !l.is_empty());
        let platform = lines.next().map(str::to_string);
        let arch = lines.next().map(str::to_string);

        // Drop the probe session immediately — it exists only to answer this.
        let _ = session.close().await;

        Ok::<_, SshError>((platform, arch))
    }
    .await;

    state.attempts.lock().await.remove(&attempt_id);

    let (platform, arch) = result?;

    Ok(SshTestResult { reachable: true, host_label, platform, arch })
}

/// Every concrete `Host` alias in `~/.ssh/config`, for the settings dropdown.
/// Empty on mobile, where there is no config to read.
#[tauri::command]
pub async fn ssh_list_config_hosts() -> Result<Vec<String>, SshError> {
    let home = home_dir();

    let Some(path) = config::default_config_path(home.as_deref()) else {
        return Ok(Vec::new());
    };

    Ok(config::list_host_aliases(&path, home.as_deref(), &config::FsConfigReader))
}

/// What `~/.ssh/config` resolves an alias to. Replaces desktop's `ssh -G`.
#[tauri::command]
pub async fn ssh_resolve_host(host: String) -> Result<SshResolvedHost, SshError> {
    let home = home_dir();

    let Some(path) = config::default_config_path(home.as_deref()) else {
        return Ok(SshResolvedHost::default());
    };

    Ok(describe_resolved(config::resolve_host(&host, &path, home.as_deref(), &config::FsConfigReader)))
}

/// Flatten a resolved Host block into what the settings form shows.
///
/// The point of the `unsupported` list is that the form can say so out loud. A
/// directive we parsed but do not honour changes where the connection actually
/// lands, so leaving it invisible would be worse than not parsing it at all.
fn describe_resolved(resolved: config::ResolvedHost) -> SshResolvedHost {
    let mut unsupported = resolved.unsupported.clone();

    if resolved.proxy_jump.is_some() {
        unsupported.push("ProxyJump".to_string());
    }

    if resolved.proxy_command.is_some() {
        unsupported.push("ProxyCommand".to_string());
    }

    SshResolvedHost {
        hostname: resolved.hostname,
        user: resolved.user,
        port: resolved.port,
        identity_file: resolved.identity_file,
        unsupported,
    }
}

/// Deliver an answer to a prompt raised by an in-flight attempt.
#[tauri::command]
pub async fn ssh_answer_prompt(
    state: State<'_, SshState>,
    attempt_id: String,
    prompt_id: String,
    answer: String,
) -> Result<(), SshError> {
    let attempt = state
        .attempts
        .lock()
        .await
        .get(&attempt_id)
        .cloned()
        .ok_or_else(|| SshError::new(SshErrorKind::Cancelled, "That connection attempt is no longer running."))?;

    let responder = attempt
        .pending
        .lock()
        .await
        .remove(&prompt_id)
        .ok_or_else(|| SshError::new(SshErrorKind::Cancelled, "That prompt is no longer waiting."))?;

    // A closed receiver means the prompt already timed out; not worth surfacing.
    let _ = responder.send(answer);

    Ok(())
}

/// Answer a host-key trust question.
#[tauri::command]
pub async fn ssh_trust_host_key(
    state: State<'_, SshState>,
    attempt_id: String,
    accept: bool,
) -> Result<(), SshError> {
    let attempt = state
        .attempts
        .lock()
        .await
        .get(&attempt_id)
        .cloned()
        .ok_or_else(|| SshError::new(SshErrorKind::Cancelled, "That connection attempt is no longer running."))?;

    let responder = attempt
        .pending_host_key
        .lock()
        .await
        .take()
        .ok_or_else(|| SshError::new(SshErrorKind::Cancelled, "No host-key decision is pending."))?;

    let _ = responder.send(accept);

    Ok(())
}

/// Abandon an in-flight attempt.
#[tauri::command]
pub async fn ssh_cancel(state: State<'_, SshState>, attempt_id: String) -> Result<(), SshError> {
    if let Some(attempt) = state.attempts.lock().await.remove(&attempt_id) {
        attempt.cancel.cancel();
    }

    Ok(())
}

/// Drop the session for a scope.
///
/// This closes the tunnel, not the remote backend — the backend is detached on
/// purpose so the next connect reuses it. Only an explicit cleanup, once
/// ownership is proven, may terminate it.
#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, SshState>, profile: Option<String>) -> Result<(), SshError> {
    let scope = scope_of(profile.as_deref());

    if let Some(session) = state.sessions.lock().await.remove(&scope) {
        let _ = session.close().await;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    /// Phase 0 gate. Touching both russh's client config and its bundled `keys`
    /// module forces the linker to actually pull the crate (and its crypto
    /// backend) rather than resolving it and dropping it as dead weight, so a
    /// green `cargo test` here is real evidence the `ring`-only feature pin
    /// builds on this target.
    #[test]
    fn russh_links_with_the_ring_backend() {
        let config = russh::client::Config::default();
        // A non-trivial default we depend on later: russh does not enable
        // keepalives by default, so ssh/session.rs must set them explicitly or a
        // half-open TCP after sleep/wake hangs instead of erroring.
        assert_eq!(config.keepalive_interval, None);

        // `russh::keys` is the bundled successor to the stale standalone
        // `russh-keys` crate. Parsing an OpenSSH public key is the exact path
        // ssh/known_hosts.rs takes, and a fixed literal keeps this test free of
        // both RNG and filesystem state.
        let key: russh::keys::PublicKey = TEST_ED25519_PUB
            .parse()
            .expect("ed25519 public keys must parse under the ring backend");

        // A missing known_hosts file must read as "host not known", never as an
        // error — TOFU on a fresh install (and on mobile, where there is no
        // ~/.ssh at all) depends on that distinction.
        let missing = std::path::Path::new("/nonexistent/hermes/known_hosts");
        assert!(
            !russh::keys::check_known_hosts_path("example.invalid", 22, &key, missing)
                .expect("a missing known_hosts file is not an error"),
            "an unknown host must report false, not error"
        );
    }

    /// A throwaway ed25519 public key, generated once for this test. Not a
    /// credential — the matching private half was never kept.
    const TEST_ED25519_PUB: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOGXTILfYe9/k4y5hfEhEtghgFt9121WP+K8hBJssvoS hermes-ssh-test";

    use super::*;

    #[test]
    fn the_default_profile_and_an_empty_profile_share_one_scope() {
        // Ownership is keyed on this, so two spellings of "no profile" must not
        // produce two remote backends.
        assert_eq!(scope_of(None), "");
        assert_eq!(scope_of(Some("")), "");
        assert_eq!(scope_of(Some("work")), "work");
        assert_ne!(scope_of(Some("work")), scope_of(Some("home")));
    }

    #[test]
    fn proxy_directives_reach_the_form_as_unsupported() {
        let resolved = config::ResolvedHost {
            hostname: Some("10.0.0.5".into()),
            user: Some("deploy".into()),
            port: Some(2222),
            proxy_jump: Some("bastion".into()),
            ..Default::default()
        };

        let dto = describe_resolved(resolved);
        assert_eq!(dto.hostname.as_deref(), Some("10.0.0.5"));
        assert!(dto.unsupported.contains(&"ProxyJump".to_string()), "{:?}", dto.unsupported);
    }

    #[test]
    fn every_unsupported_directive_is_listed_together() {
        let resolved = config::ResolvedHost {
            proxy_jump: Some("bastion".into()),
            proxy_command: Some("nc %h %p".into()),
            unsupported: vec!["Match".into()],
            ..Default::default()
        };

        let dto = describe_resolved(resolved);
        assert_eq!(dto.unsupported.len(), 3, "{:?}", dto.unsupported);
    }

    #[test]
    fn a_clean_host_reports_nothing_unsupported() {
        let dto = describe_resolved(config::ResolvedHost {
            user: Some("deploy".into()),
            ..Default::default()
        });

        assert!(dto.unsupported.is_empty());
        // Absent fields are omitted rather than serialized as null, so the form
        // can tell "not configured" from "configured empty".
        let json = serde_json::to_value(&dto).unwrap();
        assert!(json.get("hostname").is_none(), "{json}");
        assert!(json.get("unsupported").is_none(), "{json}");
    }

    #[test]
    fn connect_config_accepts_the_flattened_target_fields() {
        // The frontend sends one flat object; `#[serde(flatten)]` must absorb the
        // target fields rather than requiring a nested key.
        let config: SshConnectConfig = serde_json::from_value(serde_json::json!({
            "host": "deploy@box.example:2222",
            "keyPath": "/keys/id_ed25519",
            "remoteHermesPath": "/usr/local/bin/hermes",
            "profile": "work",
            "interactive": true
        }))
        .expect("the settings payload must deserialize");

        assert_eq!(config.target.host, "deploy@box.example:2222");
        assert_eq!(config.target.key_path.as_deref(), Some("/keys/id_ed25519"));
        assert_eq!(config.profile.as_deref(), Some("work"));
        assert!(config.interactive);
    }

    #[test]
    fn connect_config_defaults_to_non_interactive() {
        // The boot restore omits the flag, and must NOT be treated as able to
        // answer prompts — nothing is mounted to show them.
        let config: SshConnectConfig =
            serde_json::from_value(serde_json::json!({ "host": "box.example" })).unwrap();

        assert!(!config.interactive);
        assert!(config.private_key_pem.is_none());
    }

    #[test]
    fn mobile_reports_no_home_directory() {
        // Android does have a HOME, but it is an app-private sandbox with no
        // ~/.ssh in it; pretending otherwise would send the config reader and the
        // known-hosts store somewhere meaningless.
        if cfg!(target_os = "android") || cfg!(target_os = "ios") {
            assert!(home_dir().is_none());
        } else {
            assert!(home_dir().is_some(), "a desktop run should resolve a home directory");
        }
    }
}
