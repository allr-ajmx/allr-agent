use tauri::{command, AppHandle, Runtime};

use crate::{models::PermissionStatus, MicExt, Result};

/// Current OS microphone permission state without prompting.
#[command]
pub(crate) async fn check_permission<R: Runtime>(app: AppHandle<R>) -> Result<PermissionStatus> {
    app.mic().check_permission()
}

/// Request the OS microphone permission, showing the system dialog if needed.
#[command]
pub(crate) async fn request_permission<R: Runtime>(app: AppHandle<R>) -> Result<PermissionStatus> {
    app.mic().request_permission()
}
