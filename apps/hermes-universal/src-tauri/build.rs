fn main() {
    tauri_build::build();
    // Android's wry-generated `RustWebView.getCookies` null-safety patch lives in
    // gen/android/buildSrc/.../BuildTask.kt, NOT here: wry's build script has
    // rerun-if-changed on the file it emits, so patching it from cargo just makes
    // wry regenerate (revert) it on the next build.
}
