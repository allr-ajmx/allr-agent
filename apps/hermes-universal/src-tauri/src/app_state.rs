//! Durable, non-secret application state.
//!
//! Small boolean flags that describe THIS INSTALL rather than the user's account
//! — "has the connect welcome been shown". They live here, in a JSON file under
//! `app_data_dir()`, rather than in the webview's `localStorage`, because web
//! storage is the frontend's storage: it is cleared by a webview data reset, by
//! a user clearing site data, and it does not survive pointing the shell at a
//! differently-served frontend. A flag that governs whether a first-run screen
//! appears must not resurrect that screen when web storage is wiped.
//!
//! Not the keyring (`lib/secure-store.ts`) either. That is for secrets, and its
//! documented unavailable-path falls back to a `localStorage` mirror — which is
//! precisely the dependency this module exists to remove.
//!
//! Deliberately a generic key→bool store rather than one named command per flag:
//! adding the next flag should be a string in a TS union, not a round trip
//! through Rust, a capability review and a release.
//!
//! Every read degrades to `false` — a missing file, unreadable directory, or
//! JSON the last version wrote in a shape this one cannot parse all mean "not
//! seen yet". That is the safe answer: the worst case is showing a first-run
//! screen once more, whereas propagating an error would block the connect screen
//! from rendering at all.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "app-state.json";

/// The backing file, `None` when the platform won't tell us its data dir.
fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(FILE_NAME))
}

/// Parse the whole document, or an empty map for anything unusable. A non-object
/// top level (someone hand-edited it to `[]`, a truncated write) is discarded
/// rather than merged into — the alternative is failing every future write.
fn read_map(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

/// Read one flag. Only a literal JSON `true` is true; a string `"true"`, a `1`,
/// or a missing key are all false.
fn read_flag(path: &Path, key: &str) -> bool {
    read_map(path)
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Write one flag, preserving every sibling. Read → mutate → serialize → write,
/// so two different flags set in either order both survive; a blind overwrite
/// would drop whichever was written first.
fn write_flag(path: &Path, key: &str, value: bool) -> Result<(), String> {
    let mut map = read_map(path);

    map.insert(key.to_string(), Value::Bool(value));

    let body = serde_json::to_string(&Value::Object(map)).map_err(|e| e.to_string())?;

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    std::fs::write(path, body).map_err(|e| e.to_string())
}

/// Read a persisted app flag. Answers `false` rather than erroring when there is
/// no data dir, no file, or no such key — see the module note.
#[tauri::command]
pub fn get_app_flag(app: AppHandle, key: String) -> Result<bool, String> {
    Ok(state_path(&app).map_or(false, |path| read_flag(&path, &key)))
}

/// Persist an app flag. Unlike the read, this DOES surface its error: a caller
/// that could not record "the welcome was shown" is entitled to know, even
/// though the current one deliberately ignores it (showing the welcome twice
/// beats blocking the transition on a disk write).
#[tauri::command]
pub fn set_app_flag(app: AppHandle, key: String, value: bool) -> Result<(), String> {
    let path = state_path(&app).ok_or_else(|| "no_app_data_dir".to_string())?;

    write_flag(&path, &key, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch dir per test — these touch the real filesystem because
    /// the whole point of the module is what survives on it.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hermes-app-state-{name}"));

        let _ = std::fs::remove_dir_all(&dir);

        dir
    }

    #[test]
    fn missing_file_reads_false() {
        let path = scratch("missing").join(FILE_NAME);

        assert!(!read_flag(&path, "connectWelcomed"));
    }

    #[test]
    fn round_trips_a_flag() {
        let path = scratch("round-trip").join(FILE_NAME);

        assert!(!read_flag(&path, "connectWelcomed"));

        write_flag(&path, "connectWelcomed", true).expect("write");
        assert!(read_flag(&path, "connectWelcomed"));

        write_flag(&path, "connectWelcomed", false).expect("unset");
        assert!(!read_flag(&path, "connectWelcomed"));
    }

    #[test]
    fn creates_the_data_dir() {
        let path = scratch("nested").join("deeper").join(FILE_NAME);

        write_flag(&path, "connectWelcomed", true).expect("write");
        assert!(path.exists());
    }

    #[test]
    fn a_second_key_does_not_erase_the_first() {
        let path = scratch("siblings").join(FILE_NAME);

        write_flag(&path, "connectWelcomed", true).expect("first");
        write_flag(&path, "somethingElse", true).expect("second");

        assert!(read_flag(&path, "connectWelcomed"));
        assert!(read_flag(&path, "somethingElse"));
    }

    #[test]
    fn unknown_key_is_false_even_when_the_file_has_others() {
        let path = scratch("unknown-key").join(FILE_NAME);

        write_flag(&path, "connectWelcomed", true).expect("write");

        assert!(!read_flag(&path, "neverWritten"));
    }

    #[test]
    fn garbage_json_reads_false_and_is_still_writable() {
        let path = scratch("garbage").join(FILE_NAME);

        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, "{not json at all").expect("seed");

        assert!(!read_flag(&path, "connectWelcomed"));

        // A corrupt file must not wedge the store permanently.
        write_flag(&path, "connectWelcomed", true).expect("write over garbage");
        assert!(read_flag(&path, "connectWelcomed"));
    }

    #[test]
    fn non_object_top_level_reads_false_and_is_replaced() {
        let path = scratch("array").join(FILE_NAME);

        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, "[1,2,3]").expect("seed");

        assert!(!read_flag(&path, "connectWelcomed"));

        write_flag(&path, "connectWelcomed", true).expect("write");
        assert!(read_flag(&path, "connectWelcomed"));
    }

    #[test]
    fn non_bool_value_reads_false() {
        let path = scratch("wrong-type").join(FILE_NAME);

        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, r#"{"connectWelcomed":"true"}"#).expect("seed");

        assert!(!read_flag(&path, "connectWelcomed"));
    }
}
