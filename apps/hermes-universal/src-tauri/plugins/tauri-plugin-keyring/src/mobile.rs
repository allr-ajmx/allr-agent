use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::implementation::KeyringImplementation;
use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_keyring);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Keyring<R>> {
    #[cfg(target_os = "android")]
    {
        // `android-native-keyring-store` reads the Android Context/JavaVM from the global
        // `ndk_context` crate. Tauri/wry does NOT populate `ndk_context` (nothing else in
        // the tree depends on it), so the app must initialize it itself before creating a
        // store, or the first Keystore call panics with "android context was not initialized"
        // and aborts the process. We do that from the Kotlin side: registering the Android
        // plugin below runs `KeyringPlugin.load()`, which calls the store crate's
        // `initializeNdkContext` JNI entry point. Because `load()` may be deferred until the
        // WebView is created, we do NOT build the keyring_core store here — it is created
        // lazily on first use (see `implementation.rs::ensure_android_store`), by which point
        // `ndk_context` is guaranteed to be initialized.
        let handle = api.register_android_plugin(
            "com.charlesportwoodii.tauri.plugin.keyring",
            "KeyringPlugin",
        )?;
        Ok(Keyring(handle))
    }

    #[cfg(target_os = "ios")]
    {
        use apple_native_keyring_store::protected::Store as IOSStore;
        let store = IOSStore::new().map_err(|e| crate::Error::PlatformError(e.to_string()))?;
        keyring_core::set_default_store(store);
        let handle = api.register_ios_plugin(init_plugin_keyring)?;
        Ok(Keyring(handle))
    }
}

/// Access to the keyring APIs.
pub struct Keyring<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Keyring<R> {
    fn implementation(&self) -> KeyringImplementation {
        KeyringImplementation
    }

    pub fn initialize_service(&self, service_name: String) -> crate::Result<()> {
        KeyringImplementation::initialize_service(service_name)
    }

    pub fn set(
        &self,
        username: &str,
        credential_type: CredentialType,
        value: CredentialValue,
    ) -> crate::Result<()> {
        self.implementation().set(username, credential_type, value)
    }

    pub fn get(
        &self,
        username: &str,
        credential_type: CredentialType,
    ) -> crate::Result<CredentialValue> {
        self.implementation().get(username, credential_type)
    }

    pub fn delete(&self, username: &str, credential_type: CredentialType) -> crate::Result<()> {
        self.implementation().delete(username, credential_type)
    }

    pub fn exists(&self, username: &str, credential_type: CredentialType) -> crate::Result<bool> {
        self.implementation().exists(username, credential_type)
    }
}
