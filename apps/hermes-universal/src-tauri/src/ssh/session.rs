//! The live SSH session: dial, authenticate, run remote commands.
//!
//! Replaces all of `apps/desktop/electron/ssh-connection.ts`'s process
//! management. Everything that file did to coordinate an out-of-process
//! OpenSSH ControlMaster — the hashed control-socket path, the 104-byte
//! `sun_path` limit, `-O check`/`-O forward`/`-O exit`, the stale-master
//! eviction dance, and the Windows-client no-mux fallback — has no analogue
//! here. A `russh::client::Handle` held in memory *is* the multiplexed
//! connection, so it cannot be wedged by another process, cannot outlive us, and
//! cannot be left behind by a failed teardown.
//!
//! What does carry over is the timeout posture. A half-open TCP connection
//! (classically after a laptop sleeps) leaves a read pending forever rather than
//! erroring, so every operation is raced against a deadline and a timeout is
//! treated as connection-dead: the caller reconnects rather than retrying in
//! place.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::PublicKey;
use russh::ChannelMsg;

use super::auth::{authenticate, AuthMethodUsed, Credentials};
use super::error::{SshError, SshErrorKind};
use super::known_hosts::{self, HostKeyPolicy};
use super::prompt::Prompter;
use super::target::SshTarget;

pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(20);

/// Keepalive cadence. russh sends nothing by default, which would leave a
/// half-open connection after sleep/wake hanging on a read instead of erroring —
/// the exact case `SshErrorKind::Timeout` exists for. OpenSSH's own
/// `ServerAliveInterval`/`ServerAliveCountMax` defaults are the model.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
const KEEPALIVE_MAX: usize = 3;

/// What a remote command produced.
#[derive(Debug, Clone, Default)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_status: Option<u32>,
}

impl ExecOutput {
    pub fn succeeded(&self) -> bool {
        self.exit_status.unwrap_or(0) == 0
    }

    /// Stdout when the command succeeded, otherwise an error carrying stderr
    /// classified into a kind.
    pub fn require_success(self, what: &str) -> Result<String, SshError> {
        if self.succeeded() {
            return Ok(self.stdout);
        }

        let detail = if self.stderr.trim().is_empty() { self.stdout.clone() } else { self.stderr.clone() };
        let kind = super::error::classify_stderr(&detail);

        Err(SshError::new(kind, format!("{what} failed on the remote host: {}", detail.trim())))
    }
}

/// Verifies the server's key, and records *why* it said no.
///
/// russh's `check_server_key` can only answer yes/no, which would collapse "I
/// have never seen this host" and "this host's key changed" into one opaque
/// handshake failure. The verdict is stashed here so `open` can report the
/// difference — and that difference is the whole point of host-key checking.
pub struct SshHandler {
    host: String,
    port: u16,
    known_hosts_path: PathBuf,
    policy: Arc<HostKeyPolicy>,
    rejection: Arc<Mutex<Option<SshError>>>,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        match known_hosts::decide(&self.host, self.port, server_public_key, &self.known_hosts_path, &self.policy)
            .await
        {
            Ok(()) => Ok(true),
            Err(err) => {
                *self.rejection.lock().expect("host-key verdict lock") = Some(err);
                Ok(false)
            }
        }
    }
}

/// A connected, authenticated session.
pub struct SshSession {
    handle: Handle<SshHandler>,
    pub target: SshTarget,
    pub user: String,
    pub auth_method: AuthMethodUsed,
}

/// Everything `open` needs that is not the target itself.
pub struct ConnectOptions {
    pub credentials: Credentials,
    pub policy: Arc<HostKeyPolicy>,
    pub known_hosts_path: PathBuf,
    pub home: Option<PathBuf>,
    pub connect_timeout: Duration,
}

impl SshSession {
    /// Dial, verify the host key, and authenticate.
    pub async fn open(
        target: SshTarget,
        user: String,
        options: ConnectOptions,
        prompter: &dyn Prompter,
    ) -> Result<Self, SshError> {
        let port = target.effective_port();
        let rejection = Arc::new(Mutex::new(None));

        let handler = SshHandler {
            host: target.host.clone(),
            port,
            known_hosts_path: options.known_hosts_path.clone(),
            policy: Arc::clone(&options.policy),
            rejection: Arc::clone(&rejection),
        };

        let config = Arc::new(client::Config {
            keepalive_interval: Some(KEEPALIVE_INTERVAL),
            keepalive_max: KEEPALIVE_MAX,
            inactivity_timeout: None,
            ..Default::default()
        });

        let addr = (target.host.as_str(), port);

        let connect = client::connect(config, addr, handler);

        let mut handle = match tokio::time::timeout(options.connect_timeout, connect).await {
            Ok(Ok(handle)) => handle,

            Ok(Err(err)) => {
                // A rejection recorded by the handler is the real reason; the
                // handshake error it produced is a downstream symptom.
                if let Some(reason) = rejection.lock().expect("host-key verdict lock").take() {
                    return Err(reason);
                }

                return Err(SshError::new(
                    SshErrorKind::Unreachable,
                    format!("Could not reach {}: {err}", target.label()),
                ));
            }

            Err(_) => {
                return Err(SshError::new(
                    SshErrorKind::Timeout,
                    format!("Timed out connecting to {}.", target.label()),
                ))
            }
        };

        let auth_method =
            authenticate(&mut handle, &user, &options.credentials, options.home.as_deref(), prompter).await?;

        Ok(Self { handle, target, user, auth_method })
    }

    /// Run a command, optionally feeding it stdin.
    ///
    /// stdin is how secrets reach the remote: a token written this way never
    /// appears in argv, so it is invisible to `ps` and to the shell history of
    /// anyone else on that host.
    pub async fn exec(&self, command: &str, stdin: Option<&[u8]>) -> Result<ExecOutput, SshError> {
        self.exec_with_timeout(command, stdin, DEFAULT_EXEC_TIMEOUT).await
    }

    pub async fn exec_with_timeout(
        &self,
        command: &str,
        stdin: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<ExecOutput, SshError> {
        let run = self.exec_inner(command, stdin);

        match tokio::time::timeout(timeout, run).await {
            Ok(result) => result,
            // Treated as connection-dead, not as a slow command: a half-open
            // socket cannot be recovered by trying again on the same session.
            Err(_) => Err(SshError::new(
                SshErrorKind::Timeout,
                format!("A remote command on {} timed out.", self.target.label()),
            )),
        }
    }

    async fn exec_inner(&self, command: &str, stdin: Option<&[u8]>) -> Result<ExecOutput, SshError> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::new(SshErrorKind::TransientTransportError, format!("Could not open a channel: {e}")))?;

        channel
            .exec(true, command)
            .await
            .map_err(|e| SshError::new(SshErrorKind::TransientTransportError, format!("Could not start the command: {e}")))?;

        if let Some(data) = stdin {
            channel.data(data).await.map_err(|e| {
                SshError::new(SshErrorKind::TransientTransportError, format!("Could not write stdin: {e}"))
            })?;
        }

        // Always signal EOF, even with no stdin: a command that reads until EOF
        // would otherwise block forever waiting on a stream we never intend to
        // write to.
        channel
            .eof()
            .await
            .map_err(|e| SshError::new(SshErrorKind::TransientTransportError, format!("Could not close stdin: {e}")))?;

        let mut out = ExecOutput::default();
        let mut stdout: Vec<u8> = Vec::new();
        let mut stderr: Vec<u8> = Vec::new();

        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                // ext 1 is stderr per RFC 4254; anything else is not ours to interpret.
                ChannelMsg::ExtendedData { data, ext: 1 } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => out.exit_status = Some(exit_status),
                ChannelMsg::Close | ChannelMsg::Eof => {}
                _ => {}
            }
        }

        out.stdout = String::from_utf8_lossy(&stdout).into_owned();
        out.stderr = String::from_utf8_lossy(&stderr).into_owned();

        Ok(out)
    }

    /// A borrow of the handle, for opening forwarding channels.
    pub fn handle(&self) -> &Handle<SshHandler> {
        &self.handle
    }

    /// Whether the transport is still up. Cheap; does not touch the network.
    pub fn is_alive(&self) -> bool {
        !self.handle.is_closed()
    }

    /// Close the transport.
    ///
    /// Note what this does *not* do: it does not stop the remote backend. That
    /// is deliberate and matches desktop — the backend is detached on purpose so
    /// the next connect reuses it instead of paying a full spawn. Only an
    /// explicit cleanup, after ownership is proven, may terminate it.
    pub async fn close(&self) -> Result<(), SshError> {
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await
            .map_err(|e| SshError::new(SshErrorKind::Unknown, format!("Could not close the SSH session: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_status_zero_or_absent_is_success() {
        // A server that never sends exit-status is not reporting a failure.
        assert!(ExecOutput::default().succeeded());
        assert!(ExecOutput { exit_status: Some(0), ..Default::default() }.succeeded());
        assert!(!ExecOutput { exit_status: Some(1), ..Default::default() }.succeeded());
    }

    #[test]
    fn require_success_returns_stdout() {
        let out = ExecOutput { stdout: "Linux\n".into(), exit_status: Some(0), ..Default::default() };
        assert_eq!(out.require_success("uname").unwrap(), "Linux\n");
    }

    #[test]
    fn require_success_classifies_stderr() {
        let out = ExecOutput {
            stderr: "Permission denied (publickey).".into(),
            exit_status: Some(255),
            ..Default::default()
        };

        let err = out.require_success("probe").unwrap_err();
        assert_eq!(err.kind, SshErrorKind::AuthFailed);
        assert!(err.message.contains("probe failed"), "{}", err.message);
    }

    #[test]
    fn require_success_falls_back_to_stdout_when_stderr_is_empty() {
        // Plenty of remote tools report failure on stdout; an empty message
        // would leave the user with nothing to act on.
        let out = ExecOutput {
            stdout: "hermes: command not found".into(),
            stderr: "   ".into(),
            exit_status: Some(127),
            ..Default::default()
        };

        let err = out.require_success("locate hermes").unwrap_err();
        assert!(err.message.contains("command not found"), "{}", err.message);
    }

    #[test]
    fn require_success_redacts_secrets_in_the_failure() {
        let out = ExecOutput {
            stderr: "spawn failed: HERMES_DASHBOARD_SESSION_TOKEN=deadbeef".into(),
            exit_status: Some(1),
            ..Default::default()
        };

        let err = out.require_success("spawn").unwrap_err();
        assert!(!err.message.contains("deadbeef"), "{}", err.message);
    }

    #[test]
    fn keepalives_are_configured() {
        // russh sends none by default. Without them a half-open socket after
        // sleep/wake hangs on a read instead of erroring, and the Timeout kind
        // never fires.
        assert!(KEEPALIVE_INTERVAL.as_secs() > 0);
        assert!(KEEPALIVE_MAX > 0);
        assert!(client::Config::default().keepalive_interval.is_none(), "the default we override");
    }
}
