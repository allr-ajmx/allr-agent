//! Local gateway backend spawn (E3, desktop-only [GATE]).
//!
//! Desktop can run a bundled Hermes backend as a child process; a phone cannot,
//! so every command here is compiled to an `unsupported_platform` stub on mobile.
//!
//! Mirrors the desktop (Electron) contract: spawn `hermes serve --host 127.0.0.1
//! --port 0` (OS-assigned ephemeral port), hand the child a random session token
//! via `HERMES_DASHBOARD_SESSION_TOKEN`, and detect readiness in two stages —
//! (1) the child prints `HERMES_(BACKEND|DASHBOARD)_READY port=<N>` on stdout once
//! uvicorn binds, then (2) `GET {base}/api/status` succeeds. Returns a token-mode
//! connection descriptor.

use serde::Serialize;
use tokio::sync::Mutex;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackend {
    base_url: String,
    token: String,
    ws_url: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackendStatus {
    running: bool,
    base_url: Option<String>,
}

#[cfg(desktop)]
mod imp {
    use super::*;
    use std::process::Stdio;
    use std::time::Duration;

    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::{Child, Command};

    pub struct Running {
        pub child: Child,
        pub backend: LocalBackend,
    }

    /// The one live local backend (at most one at a time).
    #[derive(Default)]
    pub struct LocalBackendState(pub Mutex<Option<Running>>);

    fn random_token() -> String {
        let mut buf = [0u8; 32];
        // getrandom is infallible on every desktop OS we target.
        getrandom::getrandom(&mut buf).ok();
        buf.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Pin HERMES_HOME the way desktop does so the spawned backend shares state
    /// with the rest of the install. Delegates to the shared resolver in
    /// `plugins.rs`, which honours an explicit HERMES_HOME before falling back to
    /// the platform default — previously this computed the default unconditionally,
    /// so a user running with a custom HERMES_HOME had the spawned backend and the
    /// plugin root disagree. Falls back to the child's inherited env when
    /// unresolvable.
    fn hermes_home() -> Option<String> {
        crate::plugins::hermes_home().map(|p| p.to_string_lossy().to_string())
    }

    /// Parse `HERMES_(BACKEND|DASHBOARD)_READY port=<N>` → the announced port.
    pub fn parse_ready_port(line: &str) -> Option<u16> {
        let rest = line
            .strip_prefix("HERMES_BACKEND_READY port=")
            .or_else(|| line.strip_prefix("HERMES_DASHBOARD_READY port="))?;
        rest.trim().parse::<u16>().ok()
    }

    async fn wait_for_status(base: &str, token: &str) -> Result<(), String> {
        let client = reqwest::Client::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err("backend did not become ready within 45s".to_string());
            }
            let ok = client
                .get(format!("{base}/api/status"))
                .header("X-Hermes-Session-Token", token)
                .timeout(Duration::from_secs(3))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            if ok {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    pub async fn spawn(
        state: &LocalBackendState,
        profile: Option<String>,
    ) -> Result<LocalBackend, String> {
        // If one is already running, tear it down first.
        stop(state).await;

        let token = random_token();
        let program = std::env::var("HERMES_BIN").unwrap_or_else(|_| "hermes".to_string());

        let mut args: Vec<String> =
            vec!["serve".into(), "--host".into(), "127.0.0.1".into(), "--port".into(), "0".into()];
        if let Some(p) = profile.as_deref().filter(|p| !p.is_empty()) {
            // Profile flag goes before the subcommand, matching the desktop CLI.
            args.splice(0..0, ["--profile".to_string(), p.to_string()]);
        }

        let mut cmd = Command::new(&program);
        cmd.args(&args)
            .env("HERMES_DASHBOARD_SESSION_TOKEN", &token)
            .env("HERMES_DESKTOP", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(home) = hermes_home() {
            cmd.env("HERMES_HOME", home);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("could not start `{program}`: {e}. Is the Hermes CLI installed / on PATH?"))?;

        let stdout = child.stdout.take().ok_or("failed to capture backend stdout")?;
        let mut lines = BufReader::new(stdout).lines();

        // Stage 1: wait (≤90s) for the port announcement on stdout.
        let port = tokio::time::timeout(Duration::from_secs(90), async {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(port) = parse_ready_port(&line) {
                    return Some(port);
                }
            }
            None
        })
        .await
        .map_err(|_| "timed out waiting for the backend to announce its port".to_string())?
        .ok_or_else(|| "backend exited before announcing a port".to_string())?;

        // Keep draining stdout so the child's pipe never blocks.
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });

        let base_url = format!("http://127.0.0.1:{port}");

        // Stage 2: HTTP readiness.
        wait_for_status(&base_url, &token).await?;

        let backend = LocalBackend {
            base_url: base_url.clone(),
            token: token.clone(),
            ws_url: format!("{}/api/ws?token={token}", base_url.replacen("http", "ws", 1)),
        };
        *state.0.lock().await = Some(Running { child, backend: backend.clone() });
        Ok(backend)
    }

    pub async fn status(state: &LocalBackendState) -> LocalBackendStatus {
        match &*state.0.lock().await {
            Some(r) => LocalBackendStatus { running: true, base_url: Some(r.backend.base_url.clone()) },
            None => LocalBackendStatus::default(),
        }
    }

    pub async fn stop(state: &LocalBackendState) {
        if let Some(mut r) = state.0.lock().await.take() {
            let _ = r.child.start_kill();
        }
    }
}

// --------------------------------------------------------------------------
// Desktop: real implementation.
// --------------------------------------------------------------------------
#[cfg(desktop)]
pub use imp::LocalBackendState;

#[cfg(desktop)]
#[tauri::command]
pub async fn local_backend_spawn(
    state: tauri::State<'_, imp::LocalBackendState>,
    profile: Option<String>,
) -> Result<LocalBackend, String> {
    imp::spawn(&state, profile).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn local_backend_status(
    state: tauri::State<'_, imp::LocalBackendState>,
) -> Result<LocalBackendStatus, String> {
    Ok(imp::status(&state).await)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn local_backend_stop(
    state: tauri::State<'_, imp::LocalBackendState>,
) -> Result<(), String> {
    imp::stop(&state).await;
    Ok(())
}

// --------------------------------------------------------------------------
// Mobile: no local spawn — the UI gates this off, but the commands still exist
// so a stray call returns a clear error rather than a missing-command panic.
// --------------------------------------------------------------------------
#[cfg(mobile)]
#[derive(Default)]
pub struct LocalBackendState;

#[cfg(mobile)]
#[tauri::command]
pub async fn local_backend_spawn(
    _state: tauri::State<'_, LocalBackendState>,
    _profile: Option<String>,
) -> Result<LocalBackend, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn local_backend_status(
    _state: tauri::State<'_, LocalBackendState>,
) -> Result<LocalBackendStatus, String> {
    Ok(LocalBackendStatus::default())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn local_backend_stop(_state: tauri::State<'_, LocalBackendState>) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(all(test, desktop))]
mod tests {
    use super::imp::parse_ready_port;

    #[test]
    fn parses_backend_and_dashboard_ready_lines() {
        assert_eq!(parse_ready_port("HERMES_BACKEND_READY port=54321"), Some(54321));
        assert_eq!(parse_ready_port("HERMES_DASHBOARD_READY port=8788"), Some(8788));
    }

    #[test]
    fn ignores_unrelated_lines() {
        assert_eq!(parse_ready_port("INFO: uvicorn running"), None);
        assert_eq!(parse_ready_port("HERMES_BACKEND_READY port=notaport"), None);
    }
}
