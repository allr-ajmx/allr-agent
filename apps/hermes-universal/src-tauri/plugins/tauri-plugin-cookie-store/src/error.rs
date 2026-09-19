pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Desktop and iOS: this plugin only drives Android's `CookieManager`.
    #[error("the cookie-store plugin only runs on Android")]
    Unsupported,
    #[cfg(target_os = "android")]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}
