const COMMANDS: &[&str] = &[
    "initialize_keyring",
    "set_password",
    "set_secret",
    "get_password",
    "get_secret",
    "delete_password",
    "delete_secret",
    "has_password",
    "has_secret",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
