use serde::{Deserialize, Serialize};

/// Mirrors the state values Tauri's mobile permission layer serializes. The
/// string forms are load-bearing: on Android the base `Plugin.getPermissionStates()`
/// returns these exact kebab/lowercase strings, and `run_mobile_plugin` deserializes
/// them straight into this enum — a mismatch is a silent runtime deser failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionState {
    Granted,
    Denied,
    Prompt,
    #[serde(rename = "prompt-with-rationale")]
    PromptWithRationale,
}

/// The native side resolves a JSON object keyed by the permission *alias* declared
/// on the Android `@TauriPlugin(permissions = [Permission(alias = "microphone")])`
/// (and the matching iOS resolve). The field name here MUST equal that alias.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionStatus {
    pub microphone: PermissionState,
}
