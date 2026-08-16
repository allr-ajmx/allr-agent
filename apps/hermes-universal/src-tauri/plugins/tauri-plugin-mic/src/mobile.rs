use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::PermissionStatus;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mic);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Mic<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.nousresearch.hermes.plugin.mic", "MicPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_mic)?;
    Ok(Mic(handle))
}

/// Access to the microphone-permission APIs (mobile).
///
/// Both calls forward to the native plugin's built-in permission commands. On
/// Android those are supplied by Tauri's base `Plugin` class purely from the
/// `@TauriPlugin(permissions = [...])` annotation; on iOS the Swift `MicPlugin`
/// overrides them with `AVAudioSession`. Both resolve `{ "microphone": <state> }`,
/// which deserializes into `PermissionStatus` (field name == the "microphone" alias).
pub struct Mic<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Mic<R> {
    pub fn check_permission(&self) -> crate::Result<PermissionStatus> {
        self.0
            .run_mobile_plugin("checkPermissions", ())
            .map_err(Into::into)
    }

    pub fn request_permission(&self) -> crate::Result<PermissionStatus> {
        // No `permissions` argument → the base `requestPermissions` requests every
        // alias declared on the plugin (here just "microphone").
        self.0
            .run_mobile_plugin("requestPermissions", ())
            .map_err(Into::into)
    }
}
