use serde::{de::DeserializeOwned, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{ExpireReport, ExpireTarget};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<CookieStore<R>> {
    let handle =
        api.register_android_plugin("work.allr.plugin.cookiestore", "CookieStorePlugin")?;
    Ok(CookieStore(handle))
}

/// The `expireCookies` payload. Matches the Kotlin `ExpireCookiesArgs`.
#[derive(Serialize)]
struct ExpireCookiesArgs<'a> {
    targets: &'a [ExpireTarget],
}

/// Access to Android's app-global `CookieManager`.
pub struct CookieStore<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> CookieStore<R> {
    /// Expire every cookie `CookieManager` returns for each target URL, host-only and
    /// under each of the target's domains, then flush.
    ///
    /// The async variant on purpose: the Kotlin command runs on the Android main thread
    /// (Tauri dispatches plugin commands through wry's main-looper pipe), and a caller
    /// that blocked a thread waiting for it could be that thread.
    pub async fn expire(&self, targets: &[ExpireTarget]) -> crate::Result<ExpireReport> {
        self.0
            .run_mobile_plugin_async("expireCookies", ExpireCookiesArgs { targets })
            .await
            .map_err(Into::into)
    }
}
