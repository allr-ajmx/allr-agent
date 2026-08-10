//! Local shell PTY (right-pane terminal), desktop-only [GATE].
//!
//! The universal terminal spawns the operator's `$SHELL` in a real PTY on the
//! *local* machine and streams it to the webview's xterm over Tauri IPC —
//! mirroring the desktop (Electron) `node-pty` contract, not the gateway. Tauri's
//! webview has no `node-pty`, so the PTY lives here in Rust via `portable-pty`
//! (Unix openpty / Windows ConPTY).
//!
//! Wire path (mirrors `transport.rs`'s `ws_open` handshake): the client picks an
//! `id`, subscribes to `pty://{id}/data` (raw bytes) + `pty://{id}/exit` BEFORE
//! calling `pty_spawn`, then drives `pty_write`/`pty_resize`/`pty_kill`.
//!
//! The remote `/api/shell-pty` WS path (transport.rs + terminal-socket.ts) is kept
//! for a later "pipe the shell through the gateway" phase; this module is the
//! local-first default.

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawned {
    /// The resolved shell that was launched (for the tab title / debugging).
    shell: String,
}

// --------------------------------------------------------------------------
// Desktop: real implementation.
// --------------------------------------------------------------------------
#[cfg(desktop)]
mod imp {
    use super::*;
    use std::collections::HashMap;
    use std::io::{Read, Write};

    use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
    use tauri::{AppHandle, Emitter};
    use tokio::sync::Mutex;

    /// One live PTY: the master (for resize), the write half (keystrokes in), and
    /// a killer (the `Child` itself is owned by the reader thread so it can reap on
    /// EOF). All three are `Send`, so the map lives behind a `tokio::Mutex`.
    pub struct PtyHandle {
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        killer: Box<dyn ChildKiller + Send + Sync>,
    }

    #[derive(Default)]
    pub struct PtyState(pub Mutex<HashMap<String, PtyHandle>>);

    /// Resolve the interactive shell: `HERMES_UNIVERSAL_SHELL` override → `$SHELL`
    /// (POSIX) → first installed of zsh/bash/sh; Windows → `%COMSPEC%`/powershell.
    /// Mirrors desktop `terminalShellCommand` (apps/desktop/electron/main.ts).
    fn resolve_shell() -> String {
        if let Ok(s) = std::env::var("HERMES_UNIVERSAL_SHELL") {
            let s = s.trim();
            if !s.is_empty() {
                return s.to_string();
            }
        }
        if cfg!(target_os = "windows") {
            return std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string());
        }
        if let Ok(s) = std::env::var("SHELL") {
            let s = s.trim();
            if !s.is_empty() {
                return s.to_string();
            }
        }
        for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if std::path::Path::new(candidate).exists() {
                return candidate.to_string();
            }
        }
        "/bin/sh".to_string()
    }

    /// Validate the requested cwd (must be an existing dir), else fall back to
    /// `$HOME`/`%USERPROFILE%`. Mirrors desktop `safeTerminalCwd`.
    fn resolve_cwd(cwd: Option<String>) -> String {
        let home = || {
            std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".to_string())
        };
        match cwd {
            Some(p) if !p.trim().is_empty() && std::path::Path::new(p.trim()).is_dir() => {
                p.trim().to_string()
            }
            _ => home(),
        }
    }

    /// Build the child env from the parent's, minus color/theme-detection vars a
    /// non-tty launcher may set, plus a forced truecolor xterm profile. Mirrors
    /// desktop `terminalShellEnv`.
    fn apply_env(cmd: &mut CommandBuilder) {
        cmd.env_clear();
        for (key, value) in std::env::vars() {
            if key == "NO_COLOR"
                || key == "FORCE_COLOR"
                || key == "COLORFGBG"
                || key.starts_with("npm_config_")
                || key.starts_with("npm_package_")
            {
                continue;
            }
            cmd.env(key, value);
        }
        cmd.env("COLORTERM", "truecolor");
        cmd.env(
            "LC_CTYPE",
            std::env::var("LC_CTYPE").unwrap_or_else(|_| "UTF-8".to_string()),
        );
        cmd.env("TERM", "xterm-256color");
        cmd.env("TERM_PROGRAM", "Hermes");
        cmd.env("HERMES_UNIVERSAL_TERMINAL", "1");
    }

    pub async fn spawn(
        app: AppHandle,
        state: &PtyState,
        id: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
    ) -> Result<PtySpawned, String> {
        let shell = resolve_shell();
        let cwd = resolve_cwd(cwd);

        let size = PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| format!("openpty failed: {e}"))?;

        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(&cwd);
        apply_env(&mut cmd);

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("could not start shell `{shell}`: {e}"))?;
        // Close our handle to the slave so the reader sees EOF once the child exits
        // (otherwise the master read blocks forever). The child keeps its own fd.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("pty reader failed: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("pty writer failed: {e}"))?;
        let killer = child.clone_killer();

        // Reader thread: PTY master → `pty://{id}/data` (raw bytes). On EOF, reap
        // the child (owned here, so the wait is off the async runtime) and emit
        // `pty://{id}/exit`. Mirrors the desktop node-pty onData/onExit bridge.
        let app_reader = app.clone();
        let id_reader = id.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ =
                            app_reader.emit(&format!("pty://{id_reader}/data"), buf[..n].to_vec());
                    }
                }
            }
            let _ = child.wait();
            let _ = app_reader.emit(&format!("pty://{id_reader}/exit"), ());
        });

        state.0.lock().await.insert(
            id,
            PtyHandle {
                master: pair.master,
                writer,
                killer,
            },
        );
        Ok(PtySpawned { shell })
    }

    pub async fn write(state: &PtyState, id: String, data: String) -> Result<(), String> {
        let mut map = state.0.lock().await;
        let handle = map.get_mut(&id).ok_or("pty not found")?;
        handle
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        handle.writer.flush().map_err(|e| e.to_string())
    }

    pub async fn resize(state: &PtyState, id: String, cols: u16, rows: u16) -> Result<(), String> {
        let map = state.0.lock().await;
        let handle = map.get(&id).ok_or("pty not found")?;
        handle
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub async fn kill(state: &PtyState, id: String) -> Result<(), String> {
        if let Some(mut handle) = state.0.lock().await.remove(&id) {
            // Best-effort: the reader thread reaps via child.wait() once the master
            // closes. Dropping the handle drops the master (closing its fd).
            let _ = handle.killer.kill();
        }
        Ok(())
    }
}

#[cfg(desktop)]
pub use imp::PtyState;

#[cfg(desktop)]
#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, imp::PtyState>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<PtySpawned, String> {
    imp::spawn(app, &state, id, cols, rows, cwd).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn pty_write(
    state: tauri::State<'_, imp::PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    imp::write(&state, id, data).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn pty_resize(
    state: tauri::State<'_, imp::PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    imp::resize(&state, id, cols, rows).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn pty_kill(state: tauri::State<'_, imp::PtyState>, id: String) -> Result<(), String> {
    imp::kill(&state, id).await
}

// --------------------------------------------------------------------------
// Mobile: no local shell — the right pane isn't shown on phones anyway. The
// commands still exist so a stray call returns a clear error, not a panic.
// --------------------------------------------------------------------------
#[cfg(mobile)]
#[derive(Default)]
pub struct PtyState;

#[cfg(mobile)]
#[tauri::command]
pub async fn pty_spawn(
    _state: tauri::State<'_, PtyState>,
    _id: String,
    _cols: u16,
    _rows: u16,
    _cwd: Option<String>,
) -> Result<PtySpawned, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn pty_write(
    _state: tauri::State<'_, PtyState>,
    _id: String,
    _data: String,
) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn pty_resize(
    _state: tauri::State<'_, PtyState>,
    _id: String,
    _cols: u16,
    _rows: u16,
) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn pty_kill(_state: tauri::State<'_, PtyState>, _id: String) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}
