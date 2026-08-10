use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::KeyringExt;
use crate::Result;

#[command]
pub(crate) async fn initialize_keyring<R: Runtime>(
    app: AppHandle<R>,
    service_name: String,
) -> Result<()> {
    app.keyring().initialize_service(service_name)
}

#[command]
pub(crate) async fn set_password<R: Runtime>(
    app: AppHandle<R>,
    username: String,
    password: String,
) -> Result<()> {
    app.keyring().set(
        &username,
        CredentialType::Password,
        CredentialValue::Password(password),
    )
}

#[command]
pub(crate) async fn set_secret<R: Runtime>(
    app: AppHandle<R>,
    username: String,
    secret: Vec<u8>,
) -> Result<()> {
    app.keyring().set(
        &username,
        CredentialType::Secret,
        CredentialValue::Secret(secret),
    )
}

#[command]
pub(crate) async fn get_password<R: Runtime>(
    app: AppHandle<R>,
    username: String,
) -> Result<String> {
    match app.keyring().get(&username, CredentialType::Password)? {
        CredentialValue::Password(password) => Ok(password),
        _ => Err(crate::Error::InvalidInput("Expected password".into())),
    }
}

#[command]
pub(crate) async fn get_secret<R: Runtime>(app: AppHandle<R>, username: String) -> Result<Vec<u8>> {
    match app.keyring().get(&username, CredentialType::Secret)? {
        CredentialValue::Secret(secret) => Ok(secret),
        _ => Err(crate::Error::InvalidInput("Expected secret".into())),
    }
}

#[command]
pub(crate) async fn delete_password<R: Runtime>(app: AppHandle<R>, username: String) -> Result<()> {
    app.keyring().delete(&username, CredentialType::Password)
}

#[command]
pub(crate) async fn delete_secret<R: Runtime>(app: AppHandle<R>, username: String) -> Result<()> {
    app.keyring().delete(&username, CredentialType::Secret)
}

#[command]
pub(crate) async fn has_password<R: Runtime>(app: AppHandle<R>, username: String) -> Result<bool> {
    app.keyring().exists(&username, CredentialType::Password)
}

#[command]
pub(crate) async fn has_secret<R: Runtime>(app: AppHandle<R>, username: String) -> Result<bool> {
    app.keyring().exists(&username, CredentialType::Secret)
}
