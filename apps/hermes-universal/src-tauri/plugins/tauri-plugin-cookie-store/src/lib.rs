use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(target_os = "android")]
mod android;
#[cfg(not(target_os = "android"))]
mod unsupported;

mod error;
mod models;

pub use error::{Error, Result};

#[cfg(target_os = "android")]
use android::CookieStore;
#[cfg(not(target_os = "android"))]
use unsupported::CookieStore;

/// Access the cookie-store API from any [`tauri::Manager`].
///
/// Named `cookie_store`, not `cookies`, so it never reads as `WebviewWindow::cookies`.
pub trait CookieStoreExt<R: Runtime> {
    fn cookie_store(&self) -> &CookieStore<R>;
}

impl<R: Runtime, T: Manager<R>> crate::CookieStoreExt<R> for T {
    fn cookie_store(&self) -> &CookieStore<R> {
        self.state::<CookieStore<R>>().inner()
    }
}

/// Initializes the plugin. Registers no invoke handler: see Cargo.toml.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("cookie-store")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let store = android::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let store = unsupported::init(app, api)?;
            app.manage(store);
            Ok(())
        })
        .build()
}
