use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{PermissionState, PermissionStatus};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Mic<R>> {
    Ok(Mic(app.clone()))
}

/// Access to the microphone-permission APIs (desktop).
///
/// Desktop webviews (WebKitGTK / WKWebView / WebView2) request the OS mic
/// permission themselves on the first `getUserMedia`, so there is nothing for a
/// Rust command to gate — both calls report `Granted` and the JS seam
/// (`ensureMicPermission`) short-circuits on desktop anyway.
pub struct Mic<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> Mic<R> {
    pub fn check_permission(&self) -> crate::Result<PermissionStatus> {
        Ok(granted())
    }

    pub fn request_permission(&self) -> crate::Result<PermissionStatus> {
        Ok(granted())
    }
}

fn granted() -> PermissionStatus {
    PermissionStatus {
        microphone: PermissionState::Granted,
    }
}
