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
//! The POSIX path (steps 1-5) is live. `windows_lifecycle` — the same lifecycle
//! against a remote host running Windows — is still pure-only and is wired next.

// windows_lifecycle has no caller until its dispatch lands, and a handful of
// accessors exist for it. Without this they read as dead code and the real
// warnings drown.
#![allow(dead_code)]

pub mod auth;
pub mod clock;
pub mod config;
pub mod error;
pub mod forward;
pub mod known_hosts;
pub mod ownership;
pub mod posix_lifecycle;
pub mod progress;
pub mod prompt;
pub mod remote_paths;
pub mod remote_scripts;
pub mod reuse;
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
    /// This install's stable 32-hex id, held in the OS keyring by the frontend.
    ///
    /// Universal has no equivalent of desktop's installation-ID file, so the
    /// value is supplied rather than derived. It must be stable across launches:
    /// losing it orphans remote backends, because the next connect will not
    /// recognize the lockfile and so will neither reuse nor clean up.
    #[serde(default)]
    pub installation_id: Option<String>,
    /// The session token from the last successful connect, if we still hold one.
    /// Without it a running backend cannot be reattached to, only replaced.
    #[serde(default)]
    pub reuse_token: Option<String>,
}

/// A live SSH-backed gateway connection, as the frontend sees it.
///
/// Shaped like `local_backend.rs`'s `LocalBackend` and extended, because from
/// the app's point of view this *is* a token-authed backend on loopback — the
/// SSH part is an implementation detail of how it got there.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshConnection {
    /// Always `http://127.0.0.1:<ephemeral>`. Changes on every re-tunnel, so
    /// nothing durable may be keyed on it — use `ownership_id` instead.
    pub base_url: String,
    pub token: String,
    pub ws_url: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub pid: i64,
    /// True when we reattached to a backend that was already running.
    pub reused: bool,
    pub remote_platform: String,
    pub remote_arch: String,
    pub hermes_path: String,
    pub hermes_version: String,
    /// Stable across re-tunnels. The right cache key, and what the statusbar
    /// pill and the file tree should identify a connection by.
    pub ownership_id: String,
    /// `user@host`, for display. The loopback base URL says nothing useful.
    pub host_label: String,
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
    /// Live tunnels, kept alive by being held here: dropping a PortForward
    /// stops its accept loop.
    forwards: Mutex<HashMap<String, forward::PortForward>>,
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
    state.forwards.lock().await.remove(&scope);

    if let Some(session) = state.sessions.lock().await.remove(&scope) {
        let _ = session.close().await;
    }

    Ok(())
}

/// How often the watchdog checks that a session is still up. Cheap — it reads a
/// flag, it does not touch the network.
const SESSION_WATCH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Notice when a tunnel dies and tell the frontend.
///
/// This exists because a dead SSH tunnel is a failure mode the ordinary
/// reconnect cannot recover from. The supervisor re-dials the WebSocket against
/// `http://127.0.0.1:<ephemeral>`, but if the session is gone that port is dead
/// forever — the loop just backs off to 30s and spins. And the tunnel dying is
/// not exotic: sleep/wake, a NAT timeout, or Android reclaiming a backgrounded
/// socket all do it.
///
/// Holds a `Weak`, not an `Arc`, for two reasons: it must not keep the session
/// alive, and an ordinary `ssh_disconnect` must not look like a failure. When
/// the app drops the session deliberately the upgrade fails and this exits
/// quietly, so only an *unexpected* death emits.
async fn watch_session(app: AppHandle, scope: String, session: std::sync::Weak<SshSession>) {
    use tauri::Emitter;

    loop {
        tokio::time::sleep(SESSION_WATCH_INTERVAL).await;

        let Some(session) = session.upgrade() else {
            // Dropped on purpose. Nothing to report.
            return;
        };

        if !session.is_alive() {
            log::warn!("ssh: the session for scope {scope:?} died; the tunnel is gone");
            let _ = app.emit(&format!("ssh://{scope}/disconnected"), ());

            return;
        }
    }
}

/// 32 hex characters of randomness — the session token's shape.
fn mint_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).ok();

    hex::encode(buf)
}

/// 16 hex characters — the spawn nonce's shape.
fn mint_nonce() -> String {
    let mut buf = [0u8; 8];
    getrandom::getrandom(&mut buf).ok();

    hex::encode(buf)
}

/// Establish, or reattach to, a remote backend and tunnel to it.
///
/// The order here is load-bearing in two places, both of which cost a stranded
/// process on someone else's machine if they are rearranged:
///
///   1. The ownership record is written with `port: 0` **immediately** after
///      spawn, before readiness. If the attempt dies in that window and its
///      cleanup cannot reach the box, the next connect still finds a record it
///      can prove ownership through and reap. Without it, the orphan is
///      unreapable — nothing else ties that pid to us.
///   2. Every failure after the spawn runs `cleanup_stale`, which kills the
///      process only once it is provably ours.
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshState>,
    attempt_id: String,
    config: SshConnectConfig,
) -> Result<SshConnection, SshError> {
    let reporter = ProgressReporter::new(app.clone(), &attempt_id);
    let scope = scope_of(config.profile.as_deref());

    let installation_id = config
        .installation_id
        .as_deref()
        .ok_or_else(|| SshError::new(SshErrorKind::Unknown, "This install has no SSH identity yet."))?;

    let ownership_id = ownership::ssh_ownership_id(installation_id, &scope)?;

    let (target, user, mut credentials) = resolve_target(&config.target)?;
    credentials.private_key_pem = config.private_key_pem.clone();
    credentials.passphrase = config.passphrase.clone();
    credentials.password = config.password.clone();

    let (prompter, policy, _attempt) = arm_prompts(&app, &state, &attempt_id, config.interactive).await;
    let host_label = target.label();
    let remote_hermes_path = target.remote_hermes_path.clone();

    reporter.step(SshStep::Connecting);

    let options = ConnectOptions {
        credentials,
        policy,
        known_hosts_path: known_hosts_path(&app)?,
        home: home_dir(),
        connect_timeout: DEFAULT_CONNECT_TIMEOUT,
    };

    reporter.step(SshStep::Authenticating);
    let session = Arc::new(SshSession::open(target, user, options, prompter.as_ref()).await?);

    let result = establish(
        &session,
        &ownership_id,
        &config,
        remote_hermes_path.as_deref(),
        &host_label,
        &reporter,
    )
    .await;

    state.attempts.lock().await.remove(&attempt_id);

    match result {
        Ok((connection, forward)) => {
            // Replace any previous session for this scope, closing it first so a
            // reconnect does not leak the old tunnel.
            if let Some(previous) = state.sessions.lock().await.insert(scope.clone(), Arc::clone(&session)) {
                let _ = previous.close().await;
            }

            state.forwards.lock().await.insert(scope.clone(), forward);

            // Watch for the tunnel dying, which the WS-level reconnect cannot
            // recover from on its own.
            tokio::spawn(watch_session(app.clone(), scope, Arc::downgrade(&session)));

            Ok(connection)
        }

        Err(err) => {
            let _ = session.close().await;

            Err(err)
        }
    }
}

/// The lifecycle proper, once a session is open.
async fn establish(
    session: &Arc<SshSession>,
    ownership_id: &str,
    config: &SshConnectConfig,
    remote_hermes_path: Option<&str>,
    host_label: &str,
    reporter: &ProgressReporter,
) -> Result<(SshConnection, forward::PortForward), SshError> {
    reporter.step(SshStep::ProbingPlatform);

    let (platform, windows_runtime) =
        windows_lifecycle::detect_remote_platform(session, remote_hermes_path.unwrap_or_default()).await?;

    let profile = config.profile.clone().unwrap_or_default();
    let reuse_token = config.reuse_token.clone().unwrap_or_default();
    let client = reqwest::Client::new();

    if let Some(runtime) = windows_runtime {
        return establish_windows(
            session,
            runtime,
            ownership_id,
            &profile,
            &reuse_token,
            &platform,
            host_label,
            &client,
            reporter,
        )
        .await;
    }

    let (hermes_path, hermes_version, hermes_home) =
        posix_lifecycle::survey_hermes(session, remote_hermes_path, reporter).await?;

    reporter.step(SshStep::CheckingExisting);

    if let Some(lock) = posix_lifecycle::read_lockfile(session, ownership_id).await? {
        let pid_alive = posix_lifecycle::remote_pid_alive(session, lock.pid).await?;
        let owned = pid_alive
            && posix_lifecycle::pid_is_our_dashboard(session, lock.pid, &lock.spawn_nonce, &lock.hermes_path)
                .await?;

        if posix_lifecycle::lock_is_reusable(&lock, pid_alive, owned, &reuse_token, &hermes_path, &hermes_home) {
            reporter.step(SshStep::Forwarding);
            let forward = forward::open(Arc::clone(session), lock.port).await?;
            let base_url = forward.base_url();

            reporter.step(SshStep::Verifying);

            match reuse::probe_reuse_proof(&client, &base_url, &reuse_token, &lock.spawn_nonce).await {
                Ok(reuse::ReuseClassification::AuthenticatedOk) => {
                    let token = adopt_token(&client, session, &base_url, &reuse_token, lock.pid).await?;

                    return Ok((
                        SshConnection {
                            ws_url: ws_url_for(&base_url, &token),
                            base_url,
                            token,
                            local_port: forward.local_port,
                            remote_port: lock.port,
                            pid: lock.pid,
                            reused: true,
                            remote_platform: platform.os.clone(),
                            remote_arch: platform.arch.clone(),
                            hermes_path,
                            hermes_version,
                            ownership_id: ownership_id.to_string(),
                            host_label: host_label.to_string(),
                        },
                        forward,
                    ));
                }

                Ok(reuse::ReuseClassification::AuthenticatedStale) => {
                    // Something is on that port, but it is not the backend our
                    // record describes. Drop the tunnel and reap before respawning.
                    drop(forward);
                    posix_lifecycle::cleanup_stale(session, ownership_id, &lock, pid_alive).await?;
                }

                Err(err) => {
                    // A transport blip is not evidence about ownership; leave the
                    // backend alone and let the caller retry.
                    drop(forward);

                    return Err(err);
                }
            }
        } else {
            posix_lifecycle::cleanup_stale(session, ownership_id, &lock, pid_alive).await?;
        }
    }

    spawn_and_attach(
        session,
        ownership_id,
        &profile,
        &hermes_path,
        &hermes_version,
        &hermes_home,
        &platform,
        host_label,
        &client,
        reporter,
    )
    .await
}

/// The same lifecycle against a remote host running Windows.
///
/// Structurally identical to the POSIX path — probe, check the lock, reuse or
/// respawn, tunnel, verify — but every remote step goes through
/// `hermes_cli.windows_ssh_runtime` instead of shell commands, and identity is
/// `pid + creationTimeNs` rather than `pid + /proc/<pid>/cmdline`.
#[allow(clippy::too_many_arguments)]
async fn establish_windows(
    session: &Arc<SshSession>,
    mut runtime: windows_lifecycle::WindowsRuntime,
    ownership_id: &str,
    profile: &str,
    reuse_token: &str,
    platform: &posix_lifecycle::RemotePlatform,
    host_label: &str,
    client: &reqwest::Client,
    reporter: &ProgressReporter,
) -> Result<(SshConnection, forward::PortForward), SshError> {
    reporter.step(SshStep::LocatingHermes);
    let hermes_version = windows_lifecycle::inspect_install(session, &mut runtime).await?;
    reporter.step_with(SshStep::LocatingHermes, format!("found hermes at {}", runtime.hermes_path));

    reporter.step(SshStep::CheckingExisting);

    if let Some(lock) = windows_lifecycle::read_lock(session, &runtime, ownership_id).await? {
        let state = windows_lifecycle::process_state(session, &runtime, &lock).await?;

        // Safety rule 1 again, at the reuse gate: without a definite answer we
        // must neither reattach nor tear down. Retry rather than guess.
        if state.indeterminate {
            return Err(SshError::new(
                SshErrorKind::TransientTransportError,
                "Could not determine the state of the existing remote backend.",
            ));
        }

        let reusable = windows_lifecycle::lock_is_reusable(
            &lock,
            &state,
            reuse_token,
            &runtime.hermes_path,
            &runtime.hermes_home,
        );

        if reusable {
            reporter.step(SshStep::Forwarding);
            let forward = forward::open(Arc::clone(session), lock.port).await?;
            let base_url = forward.base_url();

            reporter.step(SshStep::Verifying);

            match reuse::probe_reuse_proof(client, &base_url, reuse_token, &lock.spawn_nonce).await {
                Ok(reuse::ReuseClassification::AuthenticatedOk) => {
                    return Ok((
                        SshConnection {
                            ws_url: ws_url_for(&base_url, reuse_token),
                            base_url,
                            token: reuse_token.to_string(),
                            local_port: forward.local_port,
                            remote_port: lock.port,
                            pid: lock.pid,
                            reused: true,
                            remote_platform: platform.os.clone(),
                            remote_arch: platform.arch.clone(),
                            hermes_path: runtime.hermes_path.clone(),
                            hermes_version,
                            ownership_id: ownership_id.to_string(),
                            host_label: host_label.to_string(),
                        },
                        forward,
                    ));
                }

                Ok(reuse::ReuseClassification::AuthenticatedStale) => {
                    drop(forward);
                    windows_lifecycle::cleanup_owned(session, &runtime, ownership_id, Some(&lock)).await?;
                }

                Err(err) => {
                    drop(forward);

                    return Err(err);
                }
            }
        } else {
            windows_lifecycle::cleanup_owned(session, &runtime, ownership_id, Some(&lock)).await?;
        }
    }

    let token = mint_token();
    let spawn_nonce = mint_nonce();

    let spawned =
        windows_lifecycle::spawn_backend(session, &runtime, ownership_id, &spawn_nonce, profile, &token, reporter)
            .await?;

    let mut lock = windows_lifecycle::WindowsLock {
        schema_version: remote_paths::LOCKFILE_SCHEMA_VERSION,
        protocol_version: remote_paths::PROTOCOL_VERSION,
        ownership_id: ownership_id.to_string(),
        spawn_nonce: spawn_nonce.clone(),
        pid: spawned.pid,
        creation_time_ns: spawned.creation_time_ns.clone(),
        // Deliberately 0 until readiness — see the ordering note on `ssh_connect`.
        port: 0,
        token_fingerprint: ownership::fingerprint_token(&token),
        profile: profile.to_string(),
        hermes_path: runtime.hermes_path.clone(),
        hermes_home: runtime.hermes_home.clone(),
        started_at: clock::now_iso8601(),
    };

    let attached =
        attach_windows(session, &runtime, ownership_id, &mut lock, &token, client, reporter).await;

    match attached {
        Ok((remote_port, forward)) => Ok((
            SshConnection {
                ws_url: ws_url_for(&forward.base_url(), &token),
                base_url: forward.base_url(),
                token,
                local_port: forward.local_port,
                remote_port,
                pid: spawned.pid,
                reused: false,
                remote_platform: platform.os.clone(),
                remote_arch: platform.arch.clone(),
                hermes_path: runtime.hermes_path.clone(),
                hermes_version,
                ownership_id: ownership_id.to_string(),
                host_label: host_label.to_string(),
            },
            forward,
        )),

        Err(err) => {
            let _ = windows_lifecycle::cleanup_owned(session, &runtime, ownership_id, Some(&lock)).await;

            Err(err)
        }
    }
}

/// Record ownership, wait for readiness, tunnel, and confirm — Windows edition.
#[allow(clippy::too_many_arguments)]
async fn attach_windows(
    session: &Arc<SshSession>,
    runtime: &windows_lifecycle::WindowsRuntime,
    ownership_id: &str,
    lock: &mut windows_lifecycle::WindowsLock,
    token: &str,
    client: &reqwest::Client,
    reporter: &ProgressReporter,
) -> Result<(u16, forward::PortForward), SshError> {
    // Written before readiness so a failure in the next few seconds still leaves
    // a reapable record. See the ordering note on `ssh_connect`.
    windows_lifecycle::write_lock(session, runtime, ownership_id, lock).await?;

    reporter.step(SshStep::WaitingReady);
    let remote_port = windows_lifecycle::wait_ready(
        session,
        runtime,
        ownership_id,
        lock,
        windows_lifecycle::DEFAULT_READY_TIMEOUT,
    )
    .await?;

    reporter.step(SshStep::Forwarding);
    let forward = forward::open(Arc::clone(session), remote_port).await?;

    reporter.step(SshStep::Verifying);
    reuse::wait_for_hermes(client, &forward.base_url(), token).await?;

    lock.port = remote_port;
    windows_lifecycle::write_lock(session, runtime, ownership_id, lock).await?;

    Ok((remote_port, forward))
}

/// Spawn a fresh backend and tunnel to it.
#[allow(clippy::too_many_arguments)]
async fn spawn_and_attach(
    session: &Arc<SshSession>,
    ownership_id: &str,
    profile: &str,
    hermes_path: &str,
    hermes_version: &str,
    hermes_home: &str,
    platform: &posix_lifecycle::RemotePlatform,
    host_label: &str,
    client: &reqwest::Client,
    reporter: &ProgressReporter,
) -> Result<(SshConnection, forward::PortForward), SshError> {
    let spawn_token = mint_token();
    let spawn_nonce = mint_nonce();

    reporter.step(SshStep::UploadingToken);
    reporter.step(SshStep::Spawning);

    let spawned = posix_lifecycle::spawn_remote_dashboard(
        session,
        hermes_path,
        Some(profile).filter(|p| !p.is_empty()),
        &spawn_token,
        ownership_id,
        &spawn_nonce,
    )
    .await?;

    let mut context = posix_lifecycle::SpawnContext {
        ownership_id,
        spawn_nonce: &spawn_nonce,
        profile,
        hermes_path,
        hermes_home,
        log_path: &spawned.log_path,
        token_fingerprint: ownership::fingerprint_token(&spawn_token),
        pid: spawned.pid,
        // Deliberately 0 — see the ordering note on `ssh_connect`.
        port: 0,
        started_at: clock::now_iso8601(),
    };

    let attached = attach_spawned(session, ownership_id, &spawned, &mut context, &spawn_token, client, reporter).await;

    match attached {
        Ok((remote_port, forward, token)) => Ok((
            SshConnection {
                ws_url: ws_url_for(&forward.base_url(), &token),
                base_url: forward.base_url(),
                token,
                local_port: forward.local_port,
                remote_port,
                pid: spawned.pid,
                reused: false,
                remote_platform: platform.os.clone(),
                remote_arch: platform.arch.clone(),
                hermes_path: hermes_path.to_string(),
                hermes_version: hermes_version.to_string(),
                ownership_id: ownership_id.to_string(),
                host_label: host_label.to_string(),
            },
            forward,
        )),

        Err(err) => {
            // Anything that fails after the spawn must reap the process we just
            // started, or it is stranded on the remote with nothing pointing at it.
            posix_lifecycle::remove_token_file(session, &spawned.token_file_path).await;
            let _ = posix_lifecycle::cleanup_stale(session, ownership_id, &context.to_lock(), true).await;

            Err(err)
        }
    }
}

/// Record ownership, wait for readiness, tunnel, and confirm.
async fn attach_spawned(
    session: &Arc<SshSession>,
    ownership_id: &str,
    spawned: &posix_lifecycle::SpawnedBackend,
    context: &mut posix_lifecycle::SpawnContext<'_>,
    spawn_token: &str,
    client: &reqwest::Client,
    reporter: &ProgressReporter,
) -> Result<(u16, forward::PortForward, String), SshError> {
    // First, before anything can go wrong: see the ordering note on `ssh_connect`.
    posix_lifecycle::write_lockfile(session, ownership_id, &context.to_lock(), &spawned.spawn_nonce).await?;

    reporter.step(SshStep::WaitingReady);
    let remote_port = posix_lifecycle::wait_for_ready_port(
        session,
        &spawned.log_path,
        spawned.pid,
        posix_lifecycle::DEFAULT_READY_TIMEOUT,
    )
    .await?;

    reporter.step(SshStep::Forwarding);
    let forward = forward::open(Arc::clone(session), remote_port).await?;
    let base_url = forward.base_url();

    reporter.step(SshStep::Verifying);
    reuse::wait_for_hermes(client, &base_url, spawn_token).await?;

    let token = adopt_token(client, session, &base_url, spawn_token, spawned.pid).await?;

    // Now that the port and the real token are known, complete the record.
    context.port = remote_port;
    context.token_fingerprint = ownership::fingerprint_token(&token);
    posix_lifecycle::write_lockfile(session, ownership_id, &context.to_lock(), &spawned.spawn_nonce).await?;

    Ok((remote_port, forward, token))
}

/// Reconcile the token we minted against the one the backend actually serves.
///
/// The minted token is only the *spawn* credential. Liveness is sampled **after**
/// the fetch, not before: a served token that differs while our process is dead
/// means something else answered, and adopting its credential would wire the app
/// to a stranger's backend.
async fn adopt_token(
    client: &reqwest::Client,
    session: &SshSession,
    base_url: &str,
    expected: &str,
    pid: i64,
) -> Result<String, SshError> {
    let served = reuse::resolve_served_token(client, base_url, expected).await;
    let alive = posix_lifecycle::remote_pid_alive(session, pid).await?;

    if reuse::is_foreign_backend(&served, expected, alive) {
        return Err(SshError::new(
            SshErrorKind::AuthenticatedStale,
            "The remote backend exited and something we did not start is answering on its port; \
             refusing that session token.",
        ));
    }

    if !alive {
        return Err(SshError::new(
            SshErrorKind::Unknown,
            "The remote backend exited while its session token was being resolved.",
        ));
    }

    Ok(served)
}

/// The gateway WebSocket URL for a tunnelled backend.
///
/// `ws:`, not `wss:` — confidentiality comes from the SSH channel, and the
/// remote backend serves no certificate for 127.0.0.1.
fn ws_url_for(base_url: &str, token: &str) -> String {
    format!("{}/api/ws?token={token}", base_url.replacen("http", "ws", 1))
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
    fn a_minted_token_and_nonce_have_the_shapes_the_lockfile_requires() {
        // The lock validator enforces exactly these, so a mismatch here would
        // make every write unreadable on the next connect.
        let token = mint_token();
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{token}");

        let nonce = mint_nonce();
        assert!(remote_paths::validate_spawn_nonce(&nonce).is_ok(), "{nonce}");
    }

    #[test]
    fn minted_values_are_not_repeated() {
        // The nonce is what proves a process is ours; a repeat would let one
        // backend be mistaken for another.
        assert_ne!(mint_token(), mint_token());
        assert_ne!(mint_nonce(), mint_nonce());
    }

    #[test]
    fn the_ws_url_rides_the_tunnel_unencrypted() {
        // ws, not wss: confidentiality comes from the SSH channel, and the remote
        // backend serves no certificate for 127.0.0.1.
        let url = ws_url_for("http://127.0.0.1:41337", "abc123");
        assert_eq!(url, "ws://127.0.0.1:41337/api/ws?token=abc123");
        assert!(!url.contains("wss://"));
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
