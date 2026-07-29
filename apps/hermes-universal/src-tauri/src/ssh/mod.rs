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
//! Phase 0: dependency de-risk only. The real modules land in later phases.

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
}
