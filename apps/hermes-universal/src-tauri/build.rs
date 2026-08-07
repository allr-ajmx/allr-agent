fn main() {
    tauri_build::build();
    patch_android_get_cookies();
}

/// Work around a wry 0.55 Android bug: the generated `RustWebView.getCookies`
/// declares a non-null `String` return but forwards `CookieManager.getCookie(url)`
/// verbatim, which returns `null` when the URL has no cookies yet. Kotlin's
/// implicit null check then throws an *uncaught* `NullPointerException` on the
/// main looper thread (via `nativePollOnce`), which ART escalates to
/// `FATAL EXCEPTION: main` and kills the whole app — our Rust-side
/// `.unwrap_or_default()` never gets the chance to swallow it.
///
/// We hit this the instant a gateway sign-in starts: `oauth.rs` polls
/// `cookies_for_url(base_url)` every 500 ms and the first ticks run before any
/// cookie exists. `cloud.rs` (Privy portal) does the same.
///
/// wry regenerates the Kotlin from its own crate template on every build, and
/// exposes no hook to override a method body, so we post-process the emitted
/// file here. Our crate depends on wry, so wry's build script (which writes the
/// file) has already run by the time this executes.
///
/// Gradle does NOT order the Kotlin compile after cargo on its own — the generated
/// source set is an undeclared input. `gen/android/buildSrc/.../RustPlugin.kt` wires
/// `compile<Arch><Profile>Kotlin` to depend on the cargo task so this patch lands
/// before the Kotlin that reads it is compiled. Without that dependency the two race,
/// and a build that loses ships the crashing `getCookies` no matter what we write here.
fn patch_android_get_cookies() {
    // Only relevant to Android builds; the env var below is set by the Tauri
    // CLI for `tauri android dev|build`.
    println!("cargo:rerun-if-env-changed=WRY_ANDROID_KOTLIN_FILES_OUT_DIR");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("android") {
        return;
    }
    let Ok(out_dir) = std::env::var("WRY_ANDROID_KOTLIN_FILES_OUT_DIR") else {
        return;
    };
    let path = std::path::Path::new(&out_dir).join("RustWebView.kt");
    let Ok(src) = std::fs::read_to_string(&path) else {
        return;
    };
    // Idempotent: the fixed form contains `?:` so re-runs are no-ops.
    let buggy = "return cookieManager.getCookie(url)";
    let fixed = "return cookieManager.getCookie(url) ?: \"\"";
    if src.contains(fixed) || !src.contains(buggy) {
        return;
    }
    let patched = src.replace(buggy, fixed);
    if std::fs::write(&path, patched).is_ok() {
        println!("cargo:warning=patched RustWebView.getCookies to be null-safe (wry 0.55 Android crash workaround)");
    }
}
