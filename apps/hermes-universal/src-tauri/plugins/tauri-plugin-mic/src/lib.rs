use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::Mic;
#[cfg(mobile)]
use mobile::Mic;

/// Access the microphone-permission APIs from any [`tauri::Manager`].
pub trait MicExt<R: Runtime> {
    fn mic(&self) -> &Mic<R>;
}

impl<R: Runtime, T: Manager<R>> crate::MicExt<R> for T {
    fn mic(&self) -> &Mic<R> {
        self.state::<Mic<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mic")
        .invoke_handler(tauri::generate_handler![
            commands::check_permission,
            commands::request_permission
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let mic = mobile::init(app, api)?;
            #[cfg(desktop)]
            let mic = desktop::init(app, api)?;
            app.manage(mic);
            Ok(())
        })
        .build()
}
