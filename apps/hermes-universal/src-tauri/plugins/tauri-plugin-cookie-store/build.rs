// No webview commands: Rust is the only caller (`run_mobile_plugin_async`), so there
// is nothing to generate a permission for and nothing a capability could grant.
const COMMANDS: &[&str] = &[];

fn main() {
    // Android only. iOS deletes cookies through WKHTTPCookieStore in the app crate, so
    // there is no Swift package to wire in.
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
