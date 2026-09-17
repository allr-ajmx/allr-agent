use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{ExpireReport, ExpireTarget};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<CookieStore<R>> {
    Ok(CookieStore(app.clone()))
}

/// Desktop and iOS stub. Those platforms delete webview cookies through wry and
/// `WKHTTPCookieStore` (the app's `webview_cookies.rs`), where the store can list
/// cookies with their domains; nothing here is ever the right tool, so it says so
/// rather than reporting "nothing to clear".
pub struct CookieStore<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> CookieStore<R> {
    pub async fn expire(&self, _targets: &[ExpireTarget]) -> crate::Result<ExpireReport> {
        Err(crate::Error::Unsupported)
    }
}
