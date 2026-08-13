//! `read_window_below` — what application is underneath our floating surface
//! (MJXHRM-213).
//!
//! # Why this is a per-OS capability rather than a library call
//!
//! There is no cross-platform way to ask "what is behind me". Wayland refuses on
//! principle: a client is not told about other clients' windows, and that is a
//! security property, not an omission. XWayland's `xprop` sees only X11 clients
//! and reports stacking that no longer means anything under a Wayland
//! compositor. So the answer has to come from whatever the *compositor* is
//! willing to say, and that is a different conversation on every desktop.
//!
//! Implemented here for **Hyprland only**, over its IPC socket — the same choice
//! the Electron desktop made, for the same reason. macOS (`CGWindowListCopy…`)
//! and Windows (`EnumWindows` + `GetWindowText`) are real work that is not done;
//! they report [`Support::Unsupported`](super::Support) through the capability
//! descriptor rather than returning an empty answer that looks like "nothing is
//! there".
//!
//! # Wire compatibility
//!
//! The JSON returned here is byte-for-byte the shape the backend's
//! `read_window_below` tool already parses (`tools/read_window_tool.py`), so the
//! gateway's `window.read.request` / `window.read.respond` round trip needs no
//! change. Metadata only — this never captures pixels.

use std::collections::BTreeMap;
#[cfg(unix)]
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Hyprland answers `j/clients` with this, plus fields we do not use.
#[derive(Clone, Debug, Deserialize)]
pub struct HyprClient {
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub at: [i32; 2],
    #[serde(default)]
    pub size: [i32; 2],
    #[serde(default)]
    pub class: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub pid: i32,
    #[serde(default)]
    pub mapped: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default, rename = "focusHistoryID")]
    pub focus_history_id: i32,
    #[serde(default)]
    pub workspace: HyprWorkspace,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct HyprWorkspace {
    #[serde(default)]
    pub id: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Bounds {
    fn overlaps(&self, other: &Bounds) -> bool {
        self.x < other.x + other.width
            && other.x < self.x + self.width
            && self.y < other.y + other.height
            && other.y < self.y + self.height
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub app: String,
    pub bounds: Bounds,
    /// Hyprland's address, an opaque hex handle. Only ever compared, never
    /// dereferenced.
    pub id: u64,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frontmost {
    pub app: String,
    pub title: String,
}

/// The answer, in the shape the backend tool already reads. Either a reading or
/// an explained refusal — never a silent empty.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum WindowBelowAnswer {
    Read {
        frontmost: Option<Frontmost>,
        platform: String,
        window: Option<WindowInfo>,
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    Unavailable {
        error: String,
        platform: String,
    },
}

impl WindowBelowAnswer {
    fn unavailable(error: impl Into<String>) -> Self {
        Self::Unavailable {
            error: error.into(),
            platform: std::env::consts::OS.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Selection — pure, so the interesting part is testable without a compositor
// ---------------------------------------------------------------------------

/// Which window is underneath us, and which application the user was last in.
///
/// Hyprland's `focusHistoryID` is focus recency (0 = focused now), **not** stack
/// order — but for this question recency is the better signal anyway: a HUD
/// floats above whatever the user is working in, so the window we want is the one
/// they were just using.
///
/// Two cases, and the difference matters:
/// - Our own window is among the clients (an ordinary toplevel surface): we know
///   our bounds, so "below" is the first other window that actually overlaps us.
/// - It is not (a layer-shell surface is not a client at all): there is nothing
///   to overlap, so "below" is simply the most recently focused other window.
pub fn pick_window_below(
    clients: &[HyprClient],
    self_pid: i32,
) -> (Option<&HyprClient>, Option<&HyprClient>) {
    let ours = clients
        .iter()
        .filter(|c| c.pid == self_pid)
        .min_by_key(|c| c.focus_history_id);

    // A window on a workspace you cannot see sits at the same coordinates as one
    // you can, and would win the overlap test. Scope to the workspace we (or the
    // focused window) are on.
    let workspace = ours.map(|c| c.workspace.id).or_else(|| {
        clients
            .iter()
            .min_by_key(|c| c.focus_history_id)
            .map(|c| c.workspace.id)
    });

    let mut others: Vec<&HyprClient> = clients
        .iter()
        .filter(|c| {
            c.pid != self_pid
                && c.mapped
                && !c.hidden
                && c.size[0] > 0
                && c.size[1] > 0
                && workspace.is_none_or(|w| c.workspace.id == w)
        })
        .collect();
    others.sort_by_key(|c| c.focus_history_id);

    let frontmost = others.first().copied();
    let below = match ours {
        Some(self_client) => {
            let self_bounds = bounds_of(self_client);
            others
                .into_iter()
                .find(|c| bounds_of(c).overlaps(&self_bounds))
        }
        None => frontmost,
    };

    (below, frontmost)
}

fn bounds_of(c: &HyprClient) -> Bounds {
    Bounds {
        x: c.at[0],
        y: c.at[1],
        width: c.size[0],
        height: c.size[1],
    }
}

fn to_info(c: &HyprClient) -> WindowInfo {
    WindowInfo {
        app: c.class.clone(),
        bounds: bounds_of(c),
        id: u64::from_str_radix(c.address.trim_start_matches("0x"), 16).unwrap_or(0),
        title: c.title.clone(),
    }
}

/// Build the answer from an already-fetched `j/clients` payload.
pub fn answer_from_clients(payload: &str, self_pid: i32) -> WindowBelowAnswer {
    let clients: Vec<HyprClient> = match serde_json::from_str(payload) {
        Ok(c) => c,
        Err(e) => {
            return WindowBelowAnswer::unavailable(format!(
                "Hyprland answered on its IPC socket but the client list did not parse: {e}"
            ))
        }
    };
    let (below, frontmost) = pick_window_below(&clients, self_pid);
    WindowBelowAnswer::Read {
        frontmost: frontmost.map(|c| Frontmost {
            app: c.class.clone(),
            title: c.title.clone(),
        }),
        platform: std::env::consts::OS.to_string(),
        window: below.map(to_info),
        note: None,
    }
}

// ---------------------------------------------------------------------------
// Which output the user is on (MJXHRM-417)
// ---------------------------------------------------------------------------

/// Hyprland answers `j/monitors` with this, plus fields we do not use.
///
/// The same socket as `j/clients` and the same trust rules, asked a different
/// question: **which output has focus**. Wayland will not tell a client that —
/// the pointer's position is not ours to read (see `surface/placement.rs`) — so
/// on this compositor the IPC socket is the only honest source, and where there
/// is no socket the capability descriptor says so rather than guessing.
#[cfg(target_os = "linux")]
#[derive(Clone, Debug, Deserialize)]
pub struct HyprMonitor {
    /// The connector, e.g. `eDP-1`.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub make: String,
    #[serde(default)]
    pub model: String,
    /// Layout position in logical pixels — the key that matches GDK geometry.
    #[serde(default)]
    pub x: i32,
    #[serde(default)]
    pub y: i32,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub disabled: bool,
}

/// The focused output in an already-fetched `j/monitors` payload.
///
/// A disabled output is skipped even if it claims focus: Hyprland keeps
/// reporting a monitor that has been switched off, and placing a surface there
/// would put the HUD somewhere with no pixels. A payload that does not parse is
/// `None` — the caller then lets the compositor choose, which is the same thing
/// it does on a compositor with no IPC at all.
#[cfg(target_os = "linux")]
pub fn focused_monitor(payload: &str) -> Option<super::placement::FocusedOutput> {
    let monitors: Vec<HyprMonitor> = serde_json::from_str(payload)
        .map_err(|e| log::info!("Hyprland's monitor list did not parse: {e}"))
        .ok()?;

    monitors
        .iter()
        .find(|m| m.focused && !m.disabled)
        .map(|m| super::placement::FocusedOutput {
            connector: m.name.clone(),
            make: m.make.clone(),
            model: m.model.clone(),
            x: f64::from(m.x),
            y: f64::from(m.y),
        })
}

/// Ask the compositor which output has focus, or `None` if it will not say.
///
/// Never fails loudly: not knowing which monitor the user is on is a *degraded*
/// placement, not an error, and the surface still opens.
#[cfg(all(unix, target_os = "linux"))]
pub fn read_focused_monitor() -> Option<super::placement::FocusedOutput> {
    let path = socket_path(&env_map(), current_uid())?;

    match request(&path, "j/monitors") {
        Ok(payload) => focused_monitor(&payload),
        Err(e) => {
            log::info!("could not ask Hyprland which output has focus: {e}");

            None
        }
    }
}

// ---------------------------------------------------------------------------
// Hyprland IPC
// ---------------------------------------------------------------------------

/// Whether a `HYPRLAND_INSTANCE_SIGNATURE` may be pasted into a path
/// (MJXHRM-382).
///
/// The signature is an environment variable, so it is attacker-chosen the moment
/// anyone can set the process environment, and it is interpolated into a
/// filesystem path. Hyprland's own signatures are `<hex>_<epoch>_<rand>`; the
/// rule here is the conservative superset of that, and it exists to stop
/// `../../..`-style traversal from pointing the IPC client at a socket in some
/// other session's directory.
fn signature_is_wellformed(signature: &str) -> bool {
    !signature.is_empty()
        && signature.len() <= 128
        && signature
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Whether an `XDG_RUNTIME_DIR` may be used as the socket's root.
///
/// Must be absolute and free of `..`: a relative or traversing value would make
/// the socket path depend on the working directory, or escape the runtime dir
/// entirely. The *ownership* of what it points at is checked separately, at
/// connect time, by [`socket_is_ours`].
fn runtime_dir_is_wellformed(dir: &str) -> bool {
    dir.starts_with('/') && !dir.split('/').any(|part| part == "..")
}

/// `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket.sock`, or `None`
/// when this is not a Hyprland session — or when the environment's answer is not
/// a shape we are willing to paste into a path. Pure so the path rule is
/// testable off-session.
pub fn socket_path(env: &BTreeMap<String, String>, uid: u32) -> Option<String> {
    let signature = env.get("HYPRLAND_INSTANCE_SIGNATURE")?;
    if !signature_is_wellformed(signature) {
        return None;
    }
    let runtime = match env.get("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()) {
        Some(dir) if runtime_dir_is_wellformed(dir) => format!("{dir}/hypr"),
        // A malformed XDG_RUNTIME_DIR is ignored rather than fatal: the default
        // location is what the variable would have named on a sane session.
        Some(_) | None => format!("/run/user/{uid}/hypr"),
    };
    Some(format!("{runtime}/{signature}/.socket.sock"))
}

/// Whether the socket at `path` belongs to us and sits somewhere only we can
/// write (MJXHRM-382).
///
/// Checked *before* connecting, because connecting is itself the interesting
/// act: the reply is parsed as JSON and turned into a report about the user's
/// screen, so a socket planted by another user is a way to feed this app a story
/// about what is on it. Refuses anything it cannot stat.
#[cfg(unix)]
fn socket_is_ours(path: &Path, uid: u32) -> bool {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};

    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.file_type().is_socket() || meta.uid() != uid {
        return false;
    }

    // Every directory above it must be ours and not writable by anyone else,
    // otherwise the socket could be swapped between this check and the connect.
    let mut current = path.parent();
    while let Some(dir) = current {
        let Ok(meta) = std::fs::metadata(dir) else {
            return false;
        };
        if meta.mode() & 0o022 != 0 || (meta.uid() != 0 && meta.uid() != uid) {
            return false;
        }
        current = dir.parent();
    }

    true
}

/// The kernel's word on who is on the other end, which is the one answer no
/// filesystem race can forge.
///
/// Linux-only: `SO_PEERCRED` is a Linux socket option, and so is Hyprland.
/// Everywhere else [`socket_is_ours`] is the whole check.
#[cfg(target_os = "linux")]
fn peer_is_ours(stream: &std::os::unix::net::UnixStream, uid: u32) -> bool {
    use std::os::unix::io::AsRawFd;

    #[repr(C)]
    struct Ucred {
        pid: i32,
        uid: u32,
        gid: u32,
    }

    const SOL_SOCKET: i32 = 1;
    const SO_PEERCRED: i32 = 17;

    let mut cred = Ucred {
        pid: 0,
        uid: u32::MAX,
        gid: u32::MAX,
    };
    let mut len = std::mem::size_of::<Ucred>() as u32;

    // SAFETY: `cred` is a correctly sized, correctly aligned `struct ucred` and
    // `len` its size; `getsockopt` writes at most `len` bytes into it and
    // updates `len`. The fd is owned by `stream` and outlives the call.
    let rc = unsafe {
        getsockopt(
            stream.as_raw_fd(),
            SOL_SOCKET,
            SO_PEERCRED,
            std::ptr::addr_of_mut!(cred).cast(),
            &mut len,
        )
    };

    rc == 0 && len as usize == std::mem::size_of::<Ucred>() && cred.uid == uid
}

#[cfg(target_os = "linux")]
extern "C" {
    fn getsockopt(
        fd: i32,
        level: i32,
        name: i32,
        value: *mut std::ffi::c_void,
        len: *mut u32,
    ) -> i32;
}

fn env_map() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

/// Whether this session can answer `read_window_below` at all.
pub fn hyprland_available() -> bool {
    #[cfg(unix)]
    {
        socket_path(&env_map(), current_uid()).is_some()
    }
    #[cfg(not(unix))]
    {
        false
    }
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: `getuid` takes no arguments, cannot fail, and touches no memory.
    unsafe { libc_getuid() }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}

/// One request, one connection, always closed.
///
/// Hyprland evaluates this socket synchronously and stalls for its own five-
/// second timeout if a connection is left open, so every path here drops the
/// stream. Called once per tool invocation, never polled.
#[cfg(unix)]
fn request(path: &str, command: &str) -> Result<String, String> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let uid = current_uid();
    if !socket_is_ours(Path::new(path), uid) {
        return Err(
            "Hyprland's IPC socket is not owned by this user, or does not sit in a directory only \
             this user can write to; refusing to talk to it"
                .to_string(),
        );
    }

    let mut stream = UnixStream::connect(path)
        .map_err(|e| format!("could not reach Hyprland's IPC socket: {e}"))?;

    #[cfg(target_os = "linux")]
    if !peer_is_ours(&stream, uid) {
        return Err(
            "the process listening on Hyprland's IPC socket runs as another user; refusing to talk \
             to it"
                .to_string(),
        );
    }

    let timeout = Some(Duration::from_millis(1000));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    stream
        .write_all(command.as_bytes())
        .map_err(|e| format!("could not send {command} to Hyprland: {e}"))?;
    let mut body = String::new();
    stream
        .read_to_string(&mut body)
        .map_err(|e| format!("Hyprland did not answer {command}: {e}"))?;
    Ok(body)
}

/// What is underneath this application's floating surface.
///
/// Answers for the calling *process*, not a particular window: Hyprland reports a
/// pid per client, and a layer-shell surface is not a client at all, so the
/// question is genuinely process-scoped. See [`pick_window_below`].
#[cfg(desktop)]
#[tauri::command]
pub async fn read_window_below() -> Result<WindowBelowAnswer, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(all(unix, target_os = "linux"))]
        {
            let Some(path) = socket_path(&env_map(), current_uid()) else {
                return WindowBelowAnswer::unavailable(unavailable_note(&env_map()));
            };
            match request(&path, "j/clients") {
                Ok(payload) => answer_from_clients(&payload, std::process::id() as i32),
                Err(e) => WindowBelowAnswer::unavailable(format!(
                    "Could not enumerate windows: {e}. Check that `hyprctl clients` works from the \
                     same session Hermes is running in."
                )),
            }
        }
        #[cfg(not(all(unix, target_os = "linux")))]
        {
            WindowBelowAnswer::unavailable(
                "Reading the window underneath is Linux/Hyprland-only in this build. A win32 \
                 EnumWindows binding and a macOS CGWindowList binding are not written yet \
                 (MJXHRM-213).",
            )
        }
    })
    .await
    .map_err(|e| format!("read_window_below failed: {e}"))
}

#[cfg(mobile)]
#[tauri::command]
pub async fn read_window_below() -> Result<WindowBelowAnswer, String> {
    Ok(WindowBelowAnswer::unavailable(
        "Reading another application's window is not something a mobile OS permits. On Android \
         this becomes screen access with per-session consent (MJXHRM-351).",
    ))
}

/// Explain *why* we cannot answer, specifically enough to act on. A generic
/// failure string here is how a Wayland user ends up filing "it returns null".
#[cfg(target_os = "linux")]
fn unavailable_note(env: &BTreeMap<String, String>) -> String {
    let wayland = env.get("XDG_SESSION_TYPE").map(String::as_str) == Some("wayland")
        || (env.contains_key("WAYLAND_DISPLAY") && !env.contains_key("DISPLAY"));
    if wayland {
        "Could not enumerate windows: this is a Wayland session, and Wayland does not let an \
         application see other applications' windows. Only Hyprland's IPC socket is implemented, \
         and this is not a Hyprland session."
            .to_string()
    } else {
        "Could not enumerate windows: reading the window underneath is not implemented for X11 in \
         this build."
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a real `hyprctl -j clients` on the development machine.
    const CLIENTS: &str = r#"[
      {"address":"0x1","at":[0,0],"size":[1920,1080],"class":"kitty","title":"term",
       "pid":100,"mapped":true,"hidden":false,"focusHistoryID":2,"workspace":{"id":2}},
      {"address":"0x2","at":[1933,46],"size":[1894,1021],"class":"Vivaldi-snap","title":"MJX Hermes",
       "pid":200,"mapped":true,"hidden":false,"focusHistoryID":0,"workspace":{"id":2}},
      {"address":"0x3","at":[1933,46],"size":[1894,1021],"class":"Other","title":"other workspace",
       "pid":300,"mapped":true,"hidden":false,"focusHistoryID":1,"workspace":{"id":7}},
      {"address":"0x4","at":[1933,46],"size":[0,0],"class":"Zero","title":"unmapped size",
       "pid":400,"mapped":true,"hidden":false,"focusHistoryID":3,"workspace":{"id":2}}
    ]"#;

    fn clients() -> Vec<HyprClient> {
        serde_json::from_str(CLIENTS).expect("fixture parses")
    }

    /// A layer-shell surface is not a Hyprland client, so there is no self entry
    /// and no bounds to overlap: the answer is the most recently focused window.
    #[test]
    fn a_layer_surface_reports_the_most_recently_focused_window() {
        let list = clients();
        let (below, frontmost) = pick_window_below(&list, 999);
        assert_eq!(below.map(|c| c.class.as_str()), Some("Vivaldi-snap"));
        assert_eq!(frontmost.map(|c| c.class.as_str()), Some("Vivaldi-snap"));
    }

    /// An ordinary toplevel is a client, so the overlap test applies.
    #[test]
    fn an_overlapping_window_wins_when_we_know_our_own_bounds() {
        let mut list = clients();
        list.push(HyprClient {
            address: "0x9".into(),
            at: [1933, 46],
            size: [400, 200],
            class: "hermes".into(),
            title: "HUD".into(),
            pid: 555,
            mapped: true,
            hidden: false,
            focus_history_id: 4,
            workspace: HyprWorkspace { id: 2 },
        });
        let (below, _) = pick_window_below(&list, 555);
        assert_eq!(below.map(|c| c.class.as_str()), Some("Vivaldi-snap"));
    }

    #[test]
    fn a_window_we_do_not_overlap_is_not_below_us() {
        let mut list = clients();
        list.push(HyprClient {
            address: "0x9".into(),
            at: [0, 0],
            size: [10, 10],
            class: "hermes".into(),
            title: "HUD".into(),
            pid: 555,
            mapped: true,
            hidden: false,
            focus_history_id: 4,
            workspace: HyprWorkspace { id: 2 },
        });
        // Only kitty covers the origin; Vivaldi is focused but sits to the right.
        let (below, frontmost) = pick_window_below(&list, 555);
        assert_eq!(below.map(|c| c.class.as_str()), Some("kitty"));
        assert_eq!(frontmost.map(|c| c.class.as_str()), Some("Vivaldi-snap"));
    }

    /// Windows on an invisible workspace occupy the same coordinates and would
    /// otherwise win the overlap test.
    #[test]
    fn another_workspace_is_never_the_window_below() {
        let list = clients();
        let (below, frontmost) = pick_window_below(&list, 999);
        assert_ne!(below.map(|c| c.class.as_str()), Some("Other"));
        assert_ne!(frontmost.map(|c| c.class.as_str()), Some("Other"));
    }

    #[test]
    fn zero_sized_clients_are_ignored() {
        let list = clients();
        let (below, _) = pick_window_below(&list, 200);
        assert_ne!(below.map(|c| c.class.as_str()), Some("Zero"));
    }

    #[test]
    fn our_own_windows_are_never_the_answer() {
        let list = clients();
        let (below, frontmost) = pick_window_below(&list, 200);
        assert_ne!(below.map(|c| c.pid), Some(200));
        assert_ne!(frontmost.map(|c| c.pid), Some(200));
    }

    #[test]
    fn the_hex_address_becomes_an_opaque_numeric_id() {
        let list = clients();
        let info = to_info(&list[1]);
        assert_eq!(info.id, 2);
        assert_eq!(info.app, "Vivaldi-snap");
        assert_eq!(info.bounds.width, 1894);
    }

    #[test]
    fn a_malformed_payload_explains_itself_rather_than_returning_nothing() {
        match answer_from_clients("not json", 1) {
            WindowBelowAnswer::Unavailable { error, .. } => {
                assert!(error.contains("did not parse"), "{error}")
            }
            other => panic!("expected an explained refusal, got {other:?}"),
        }
    }

    #[test]
    fn the_socket_path_follows_the_runtime_dir() {
        let mut env = BTreeMap::new();
        env.insert("HYPRLAND_INSTANCE_SIGNATURE".into(), "sig".into());
        env.insert("XDG_RUNTIME_DIR".into(), "/run/user/1000".into());
        assert_eq!(
            socket_path(&env, 1000).as_deref(),
            Some("/run/user/1000/hypr/sig/.socket.sock")
        );
    }

    #[test]
    fn the_socket_path_falls_back_to_the_uid_when_the_runtime_dir_is_unset() {
        let mut env = BTreeMap::new();
        env.insert("HYPRLAND_INSTANCE_SIGNATURE".into(), "sig".into());
        assert_eq!(
            socket_path(&env, 1234).as_deref(),
            Some("/run/user/1234/hypr/sig/.socket.sock")
        );
    }

    #[test]
    fn no_signature_means_no_socket() {
        assert!(socket_path(&BTreeMap::new(), 1000).is_none());
        let mut empty = BTreeMap::new();
        empty.insert("HYPRLAND_INSTANCE_SIGNATURE".into(), String::new());
        assert!(socket_path(&empty, 1000).is_none());
    }

    // -----------------------------------------------------------------------
    // Path validation (MJXHRM-382)
    // -----------------------------------------------------------------------

    #[test]
    fn a_traversing_signature_never_reaches_the_path() {
        for signature in [
            "../../../tmp/evil",
            "sig/../..",
            "sig with spaces",
            "sig\0",
            "sig\n",
            "/absolute",
            &"x".repeat(129),
        ] {
            let mut env = BTreeMap::new();
            env.insert("HYPRLAND_INSTANCE_SIGNATURE".into(), signature.into());
            env.insert("XDG_RUNTIME_DIR".into(), "/run/user/1000".into());
            assert!(
                socket_path(&env, 1000).is_none(),
                "{signature:?} should be refused"
            );
        }

        // A real Hyprland signature still passes.
        assert!(signature_is_wellformed("b7a1f0c2_1754800000_123456789"));
    }

    #[test]
    fn a_traversing_runtime_dir_falls_back_to_the_default() {
        for dir in ["/run/user/1000/../../tmp", "relative/dir", "../up"] {
            let mut env = BTreeMap::new();
            env.insert("HYPRLAND_INSTANCE_SIGNATURE".into(), "sig".into());
            env.insert("XDG_RUNTIME_DIR".into(), dir.into());
            assert_eq!(
                socket_path(&env, 1000).as_deref(),
                Some("/run/user/1000/hypr/sig/.socket.sock"),
                "{dir:?} should not steer the socket path"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_or_non_socket_path_is_refused() {
        // Neither of these is a socket owned by us, and "cannot tell" must read
        // as "no" — this is the check that runs before we connect.
        assert!(!socket_is_ours(
            Path::new("/nonexistent/hypr/sig/.socket.sock"),
            current_uid()
        ));
        assert!(!socket_is_ours(Path::new("/etc/hostname"), current_uid()));
    }

    /// The serialized shape is a contract with `tools/read_window_tool.py`, which
    /// parses this JSON as-is.
    #[test]
    fn the_answer_serializes_to_the_shape_the_backend_tool_reads() {
        let answer = answer_from_clients(CLIENTS, 999);
        let json = serde_json::to_value(&answer).expect("serializes");
        assert!(json.get("platform").is_some());
        assert_eq!(json["window"]["app"], "Vivaldi-snap");
        assert_eq!(json["window"]["bounds"]["x"], 1933);
        assert_eq!(json["frontmost"]["title"], "MJX Hermes");
        // Absent rather than null, matching the desktop payload.
        assert!(json.get("note").is_none());
    }

    #[test]
    fn an_unavailable_answer_carries_an_error_and_no_window_key() {
        let json =
            serde_json::to_value(WindowBelowAnswer::unavailable("nope")).expect("serializes");
        assert_eq!(json["error"], "nope");
        assert!(json.get("window").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_wayland_refusal_names_wayland() {
        let mut env = BTreeMap::new();
        env.insert("XDG_SESSION_TYPE".into(), "wayland".into());
        assert!(unavailable_note(&env).contains("Wayland"));
        assert!(unavailable_note(&BTreeMap::new()).contains("X11"));
    }

    // -----------------------------------------------------------------------
    // Which output has focus (MJXHRM-417)
    // -----------------------------------------------------------------------

    /// Two outputs as `hyprctl -j monitors` really prints them on the
    /// development machine, trimmed to the keys this reads. `focused` is
    /// substituted so one fixture covers both answers.
    #[cfg(target_os = "linux")]
    fn monitors_payload(focused: &str, disabled_focused: bool) -> String {
        format!(
            r#"[
              {{"id":0,"name":"HDMI-A-1","description":"Hewlett Packard HP 22es 3CM6480R8G",
                "make":"Hewlett Packard","model":"HP 22es","width":1920,"height":1080,
                "x":0,"y":0,"scale":1.00,"focused":{hdmi},"disabled":false}},
              {{"id":1,"name":"eDP-1","description":"BOE 0x08DF","make":"BOE","model":"0x08DF",
                "width":1920,"height":1080,"x":1920,"y":0,"scale":1.00,
                "focused":{edp},"disabled":{disabled}}}
            ]"#,
            hdmi = focused == "HDMI-A-1",
            edp = focused == "eDP-1",
            disabled = disabled_focused,
        )
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_focused_output_comes_back_with_its_layout_origin() {
        let output = focused_monitor(&monitors_payload("eDP-1", false)).expect("an output");
        assert_eq!(output.connector, "eDP-1");
        assert_eq!(output.model, "0x08DF");
        assert_eq!((output.x, output.y), (1920.0, 0.0));

        let output = focused_monitor(&monitors_payload("HDMI-A-1", false)).expect("an output");
        assert_eq!(output.connector, "HDMI-A-1");
        assert_eq!((output.x, output.y), (0.0, 0.0));
    }

    /// A switched-off monitor keeps its `focused` flag in Hyprland's answer.
    /// Placing the HUD there would put it on a screen with no pixels, so the
    /// answer must be "we do not know" and the compositor gets to choose.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_disabled_output_is_never_the_answer() {
        assert!(focused_monitor(&monitors_payload("eDP-1", true)).is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_payload_with_no_focused_output_chooses_nothing() {
        assert!(focused_monitor(&monitors_payload("none", false)).is_none());
        assert!(focused_monitor("[]").is_none());
    }

    /// Unparseable is "we do not know", not a panic and not a wrong monitor:
    /// this runs while a window is being built and must not take the HUD down
    /// with it.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_malformed_monitor_list_chooses_nothing() {
        assert!(focused_monitor("not json").is_none());
        assert!(focused_monitor(r#"{"name":"eDP-1"}"#).is_none());
    }
}
