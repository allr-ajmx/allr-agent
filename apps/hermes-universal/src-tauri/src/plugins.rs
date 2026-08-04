//! The LOCAL plugin door — `$HERMES_HOME[/profiles/<p>]/desktop-plugins/<name>/plugin.js`.
//!
//! Port of the Electron `hermes:fs:desktopPluginsRoot` + readDir/readFileText
//! trio (apps/desktop/electron/main.ts:10910) onto Tauri/Rust.
//!
//! SECURITY / TRUST: this door only READS files. The webview evaluates what comes
//! back, which is error isolation, not a capability boundary — a plugin runs with
//! the app's full authority. What these commands do guarantee is the ADDRESS
//! SPACE: a folder NAME is the only thing a caller may supply, never a path. No
//! command accepts an absolute path, so there is no scope to misconfigure and no
//! way to read outside the plugin root.
//!
//! Deliberately narrow commands rather than `tauri-plugin-fs` grants:
//!   * fs scopes are static and cannot express a runtime profile segment
//!     (`$HOME/.hermes/profiles/<active profile>/desktop-plugins`);
//!   * `fs:allow-watch` is not in the capability set, and enabling it is a whole
//!     feature flag;
//!   * handing the webview a general read-dir primitive widens the renderer's
//!     authority for a door that is explicitly not a trust boundary.
//! `marketplace_search`/`marketplace_fetch` is the in-repo precedent.
//!
//! LOCALITY IS THE INVARIANT (desktop bug #66899): the root is resolved from THIS
//! machine's HERMES_HOME, never from the connected backend's `hermes_home`. A
//! remote backend must not be able to point the local loader at its own files;
//! that path exists deliberately and separately as the frontend's REST door.

use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

const PLUGIN_DIR: &str = "desktop-plugins";
const PLUGIN_ENTRY: &str = "plugin.js";

/// One discovered plugin folder.
#[derive(Serialize)]
pub struct PluginDirEntry {
    /// Folder name — the ONLY handle `plugins_read` accepts.
    name: String,
    /// Absolute path to plugin.js, for display + "reveal in file manager".
    file: String,
    /// Modification time in ms; the frontend polls this to spot an edit without
    /// re-reading the source.
    mtime_ms: u64,
    size: u64,
}

/// This machine's HERMES_HOME: the explicit env var if set, else the platform
/// default desktop uses (%LOCALAPPDATA%\hermes on Windows, ~/.hermes elsewhere).
///
/// The env override matters: `local_backend` passes HERMES_HOME to the backend it
/// spawns, but computed the default without honouring an existing value — so a
/// user running with a custom HERMES_HOME would have had the plugin root and the
/// backend disagree.
pub(crate) fn hermes_home() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("HERMES_HOME") {
        let trimmed = explicit.trim();

        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    if cfg!(target_os = "windows") {
        std::env::var("LOCALAPPDATA").ok().map(|p| PathBuf::from(p).join("hermes"))
    } else {
        std::env::var("HOME").ok().map(|p| PathBuf::from(p).join(".hermes"))
    }
}

/// Resolve the plugin root for `profile` under `home`. Profile-aware exactly like
/// the Electron resolver: the default profile lives at the home root, a named one
/// under `profiles/<name>/`.
///
/// Split out from `root_for` so it is testable WITHOUT touching the process
/// environment — cargo runs tests in parallel threads, and mutating a global env
/// var made these races against each other.
fn plugin_root_under(home: PathBuf, profile: Option<&str>) -> Result<PathBuf, String> {
    let mut base = home;

    if let Some(name) = profile.map(str::trim).filter(|p| !p.is_empty()) {
        if name != "default" && name != "current" {
            // A profile name is user data; it must not be able to climb out.
            if !safe_segment(name) {
                return Err(format!("illegal profile name \"{name}\""));
            }

            base = base.join("profiles").join(name);
        }
    }

    Ok(base.join(PLUGIN_DIR))
}

fn root_for(profile: Option<String>) -> Result<PathBuf, String> {
    let home = hermes_home().ok_or("could not resolve HERMES_HOME on this platform")?;

    plugin_root_under(home, profile.as_deref())
}

/// A single, well-behaved path segment: no separators, no traversal, not hidden.
fn safe_segment(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// Absolute path of the plugin root, created on demand so a "reveal" always has
/// somewhere to go. Creation failure is not fatal — the path is still returned so
/// the caller can show a real error instead of an empty inventory.
#[tauri::command]
pub fn plugins_root(profile: Option<String>) -> Result<String, String> {
    let root = root_for(profile)?;
    let _ = std::fs::create_dir_all(&root);

    Ok(root.to_string_lossy().to_string())
}

/// Every `<root>/<name>/plugin.js` that exists and is readable. A folder without
/// a readable entry file is not a plugin and is skipped silently — the directory
/// is a user-writable drop point, so stray files are expected, not errors.
#[tauri::command]
pub fn plugins_list(profile: Option<String>) -> Result<Vec<PluginDirEntry>, String> {
    let root = root_for(profile)?;

    let dir = match std::fs::read_dir(&root) {
        Ok(dir) => dir,
        // No root yet = no plugins yet. The scanner should see an empty list, not
        // an error it has to special-case on every poll tick.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("could not read {}: {err}", root.display())),
    };

    let mut out = Vec::new();

    for entry in dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();

        if !safe_segment(&name) || !entry.path().is_dir() {
            continue;
        }

        let file = entry.path().join(PLUGIN_ENTRY);

        let Ok(meta) = std::fs::metadata(&file) else {
            continue;
        };

        if !meta.is_file() {
            continue;
        }

        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        out.push(PluginDirEntry {
            name,
            file: file.to_string_lossy().to_string(),
            mtime_ms,
            size: meta.len(),
        });
    }

    // Stable order so the inventory doesn't reshuffle between polls.
    out.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(out)
}

/// Source of `<root>/<name>/plugin.js`. `name` is a folder name, never a path —
/// anything with a separator or traversal is refused before touching the disk.
#[tauri::command]
pub fn plugins_read(profile: Option<String>, name: String) -> Result<String, String> {
    if !safe_segment(&name) {
        return Err(format!("illegal plugin name \"{name}\""));
    }

    let file = root_for(profile)?.join(&name).join(PLUGIN_ENTRY);

    std::fs::read_to_string(&file).map_err(|err| format!("could not read {}: {err}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_names_that_could_escape_the_root() {
        for name in ["..", ".", "", "a/b", "a\\b", "../etc", ".hidden", "a\0b"] {
            assert!(!safe_segment(name), "{name} should be refused");
        }
    }

    #[test]
    fn accepts_ordinary_folder_names() {
        for name in ["kanban", "cost-meter", "my_plugin", "a.b"] {
            assert!(safe_segment(name), "{name} should be allowed");
        }
    }

    #[test]
    fn plugins_read_refuses_a_path_instead_of_a_name() {
        assert!(plugins_read(None, "../../etc/passwd".into()).is_err());
        assert!(plugins_read(None, "/etc/passwd".into()).is_err());
    }

    fn home() -> PathBuf {
        PathBuf::from("/tmp/hermes-test-home")
    }

    #[test]
    fn default_profile_uses_the_home_root_and_named_profiles_nest() {
        let default = plugin_root_under(home(), None).unwrap();
        let explicit_default = plugin_root_under(home(), Some("default")).unwrap();
        let current = plugin_root_under(home(), Some("current")).unwrap();
        let blank = plugin_root_under(home(), Some("  ")).unwrap();
        let named = plugin_root_under(home(), Some("work")).unwrap();

        assert_eq!(default, home().join("desktop-plugins"));
        // "default" / "current" / blank all mean the home root, not a subfolder.
        assert_eq!(default, explicit_default);
        assert_eq!(default, current);
        assert_eq!(default, blank);
        assert_eq!(named, home().join("profiles").join("work").join("desktop-plugins"));
    }

    #[test]
    fn a_bad_profile_name_is_refused() {
        for profile in ["../escape", "a/b", "a\\b", ".hidden"] {
            assert!(plugin_root_under(home(), Some(profile)).is_err(), "{profile} should be refused");
        }
    }

    // hermes_home() reads a process-global env var, so anything asserting on it
    // must serialize — cargo runs tests in parallel threads within one process.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn honours_an_explicit_hermes_home() {
        let _guard = ENV_LOCK.lock().unwrap();

        // SAFETY: every test that touches HERMES_HOME holds ENV_LOCK.
        unsafe { std::env::set_var("HERMES_HOME", "/tmp/custom-home") };
        assert_eq!(hermes_home().unwrap(), PathBuf::from("/tmp/custom-home"));

        // A blank value must not shadow the platform default.
        unsafe { std::env::set_var("HERMES_HOME", "  ") };
        assert_ne!(hermes_home(), Some(PathBuf::from("  ")));

        unsafe { std::env::remove_var("HERMES_HOME") };
    }

    #[test]
    fn listing_a_missing_root_is_empty_not_an_error() {
        let _guard = ENV_LOCK.lock().unwrap();

        unsafe { std::env::set_var("HERMES_HOME", "/tmp/hermes-does-not-exist-XYZ") };
        assert_eq!(plugins_list(None).unwrap().len(), 0);
        unsafe { std::env::remove_var("HERMES_HOME") };
    }
}
