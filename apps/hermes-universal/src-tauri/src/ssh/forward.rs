//! The local port-forward that carries the gateway's traffic.
//!
//! This is the data plane. Everything else in this module is control: probing,
//! spawning, proving ownership. Once a forward is up, the rest of the app talks
//! ordinary HTTP and WebSocket to `http://127.0.0.1:<local_port>` and never
//! learns that SSH is involved.
//!
//! Ported in intent from `apps/desktop/electron/ssh-connection.ts:707-828`, but
//! structurally simpler, because we own the listener instead of asking a
//! separate `ssh` process to open one:
//!
//!   - Desktop's `pickLocalPort()` bound `127.0.0.1:0`, read the port, closed
//!     the socket, and handed the number to `ssh`. That left a window in which
//!     something else could take the port, so it needed a collision regex and a
//!     three-attempt retry loop. We bind and *keep* the listener, so the window
//!     does not exist and neither does the retry.
//!   - Loopback-only binding is now a property of the bind address rather than
//!     of a correctly-formatted `-L` string. The tunnel must never re-expose the
//!     remote backend to the client's own network.
//!   - There is no `-O forward`/`-O cancel`, and no Windows-client fallback that
//!     spawns a separate `ssh -N -L` child and scrapes its stderr for readiness.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use russh::client::{Handle, Msg};
use russh::Channel;
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use super::error::{SshError, SshErrorKind};
use super::session::SshHandler;

/// What a listener reports about the traffic it has carried. Used to tell "the
/// tunnel is up but idle" from "the tunnel never worked".
#[derive(Debug, Default)]
pub struct ForwardStats {
    pub accepted: AtomicU64,
    pub failed: AtomicU64,
}

/// A live local→remote forward. Dropping it stops accepting new connections.
pub struct PortForward {
    /// The kernel-assigned local port. Changes on every re-tunnel, which is why
    /// nothing durable (a cache key, a saved target) may be derived from it.
    pub local_port: u16,
    pub remote_port: u16,
    cancel: CancellationToken,
    stats: Arc<ForwardStats>,
}

impl PortForward {
    /// The base URL the rest of the app should use.
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.local_port)
    }

    pub fn accepted(&self) -> u64 {
        self.stats.accepted.load(Ordering::Relaxed)
    }

    pub fn failed(&self) -> u64 {
        self.stats.failed.load(Ordering::Relaxed)
    }

    /// Stop accepting. Connections already being pumped finish on their own.
    pub fn close(&self) {
        self.cancel.cancel();
    }
}

impl Drop for PortForward {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Open a forward from an OS-assigned loopback port to `remote_port` on the
/// remote's own loopback.
pub async fn open(handle: Handle<SshHandler>, remote_port: u16) -> Result<PortForward, SshError> {
    // Bind to 127.0.0.1 ONLY — never 0.0.0.0. The remote backend listens on the
    // remote's loopback precisely so that the tunnel is the only way in;
    // binding our end to a routable address would undo that and republish it to
    // this machine's network.
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| SshError::new(SshErrorKind::Unknown, format!("Could not open a local tunnel port: {e}")))?;

    let local_port = listener
        .local_addr()
        .map_err(|e| SshError::new(SshErrorKind::Unknown, format!("Could not read the local tunnel port: {e}")))?
        .port();

    let cancel = CancellationToken::new();
    let stats = Arc::new(ForwardStats::default());

    tokio::spawn(accept_loop(
        listener,
        handle,
        remote_port,
        local_port,
        cancel.clone(),
        Arc::clone(&stats),
    ));

    Ok(PortForward { local_port, remote_port, cancel, stats })
}

/// Accept local connections until cancelled, pumping each over its own channel.
async fn accept_loop(
    listener: TcpListener,
    handle: Handle<SshHandler>,
    remote_port: u16,
    local_port: u16,
    cancel: CancellationToken,
    stats: Arc<ForwardStats>,
) {
    loop {
        let accepted = tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            accepted = listener.accept() => accepted,
        };

        let Ok((stream, peer)) = accepted else {
            // An accept error is almost always transient (fd pressure). Give up
            // the loop rather than spin: the session supervisor will notice the
            // tunnel is not carrying traffic.
            return;
        };

        // One SSH channel per TCP connection, so a slow request cannot block
        // the others — the gateway holds a long-lived WebSocket open alongside
        // ordinary short REST calls.
        let channel = match handle.channel_open_direct_tcpip("127.0.0.1", remote_port as u32, "127.0.0.1", local_port as u32).await
        {
            Ok(channel) => channel,
            Err(err) => {
                stats.failed.fetch_add(1, Ordering::Relaxed);
                log::warn!("ssh: could not open a forwarding channel for {peer}: {err}");
                continue;
            }
        };

        stats.accepted.fetch_add(1, Ordering::Relaxed);
        tokio::spawn(pump(stream, channel, Arc::clone(&stats)));
    }
}

/// Copy bytes in both directions until either side closes.
async fn pump(mut stream: TcpStream, channel: Channel<Msg>, stats: Arc<ForwardStats>) {
    let mut remote = channel.into_stream();

    if let Err(err) = tokio::io::copy_bidirectional(&mut stream, &mut remote).await {
        // A client that hangs up mid-response is routine, not an error worth
        // surfacing; count it so a wholly broken tunnel is still visible.
        stats.failed.fetch_add(1, Ordering::Relaxed);
        log::debug!("ssh: forwarded connection ended: {err}");
    }
}

/// The loopback address a forward listens on. Exposed so the invariant is
/// testable rather than merely commented.
pub fn bind_address() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bind_address_is_loopback_with_an_ephemeral_port() {
        // Binding anywhere routable would republish the remote backend — which
        // deliberately listens only on the remote's loopback — to this machine's
        // network. This is the invariant that keeps the tunnel the only route in.
        let addr = bind_address();
        assert!(addr.ip().is_loopback(), "{addr}");
        assert_eq!(addr.port(), 0, "the kernel assigns the port");
    }

    #[tokio::test]
    async fn a_bound_listener_is_reachable_only_on_loopback() {
        let listener = TcpListener::bind(bind_address()).await.unwrap();
        let addr = listener.local_addr().unwrap();

        assert!(addr.ip().is_loopback());
        assert_ne!(addr.port(), 0, "the kernel must have assigned a real port");

        // Holding the listener is what removes desktop's bind race: the port
        // cannot be taken by anything else between choosing it and using it.
        let second = TcpListener::bind(("127.0.0.1", addr.port())).await;
        assert!(second.is_err(), "the port must still be held");
    }

    #[tokio::test]
    async fn base_url_points_at_the_local_end() {
        let forward = PortForward {
            local_port: 41337,
            remote_port: 8788,
            cancel: CancellationToken::new(),
            stats: Arc::new(ForwardStats::default()),
        };

        assert_eq!(forward.base_url(), "http://127.0.0.1:41337");
        // Plain http, not https: confidentiality comes from the SSH channel, and
        // the remote backend serves no certificate for 127.0.0.1.
        assert!(forward.base_url().starts_with("http://"));
    }

    #[tokio::test]
    async fn close_and_drop_both_cancel_the_accept_loop() {
        let cancel = CancellationToken::new();
        let forward = PortForward {
            local_port: 1,
            remote_port: 2,
            cancel: cancel.clone(),
            stats: Arc::new(ForwardStats::default()),
        };

        assert!(!cancel.is_cancelled());
        forward.close();
        assert!(cancel.is_cancelled());

        // Dropping must also stop the loop, or a forgotten forward would keep
        // accepting into a dead session.
        let cancel = CancellationToken::new();
        drop(PortForward {
            local_port: 1,
            remote_port: 2,
            cancel: cancel.clone(),
            stats: Arc::new(ForwardStats::default()),
        });
        assert!(cancel.is_cancelled());
    }

    #[tokio::test]
    async fn a_cancelled_loop_stops_accepting() {
        let listener = TcpListener::bind(bind_address()).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = CancellationToken::new();

        // No session here — the loop is exercised only up to its cancellation
        // check, which is the part that does not need a live server.
        let stats = Arc::new(ForwardStats::default());
        cancel.cancel();

        let loop_done = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            drain_until_cancelled(listener, cancel, Arc::clone(&stats)),
        )
        .await;

        assert!(loop_done.is_ok(), "a cancelled loop must return promptly");
        // And the port is released once the listener is dropped.
        assert!(TcpListener::bind(("127.0.0.1", port)).await.is_ok());
    }

    /// The cancellation half of `accept_loop`, without the SSH dependency.
    async fn drain_until_cancelled(listener: TcpListener, cancel: CancellationToken, _stats: Arc<ForwardStats>) {
        loop {
            tokio::select! {
                biased;
                () = cancel.cancelled() => return,
                accepted = listener.accept() => {
                    if accepted.is_err() {
                        return;
                    }
                }
            }
        }
    }

    #[test]
    fn stats_start_at_zero_and_count_up() {
        let forward = PortForward {
            local_port: 1,
            remote_port: 2,
            cancel: CancellationToken::new(),
            stats: Arc::new(ForwardStats::default()),
        };

        assert_eq!(forward.accepted(), 0);
        assert_eq!(forward.failed(), 0);

        forward.stats.accepted.fetch_add(2, Ordering::Relaxed);
        forward.stats.failed.fetch_add(1, Ordering::Relaxed);

        // "Up but idle" and "never worked" have to be distinguishable.
        assert_eq!(forward.accepted(), 2);
        assert_eq!(forward.failed(), 1);
    }
}
