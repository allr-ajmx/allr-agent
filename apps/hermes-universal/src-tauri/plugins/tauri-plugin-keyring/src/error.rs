use serde::Serialize;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "type", content = "message")]
pub enum Error {
    #[error("No default keyring store has been configured")]
    NoDefaultStore,

    #[error("Entry not found in keyring")]
    EntryNotFound,

    #[error("Multiple matching entries found")]
    AmbiguousEntry,

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("Platform error: {0}")]
    PlatformError(String),

    #[error("Invalid UTF-8 data")]
    InvalidUtf8,

    #[error("IO error: {0}")]
    Io(String),

    #[cfg(mobile)]
    #[error("Plugin invocation error: {0}")]
    PluginInvoke(String),
}

// Convert from keyring_core errors
impl From<keyring_core::Error> for Error {
    fn from(err: keyring_core::Error) -> Self {
        match err {
            keyring_core::Error::NoDefaultStore => Error::NoDefaultStore,
            keyring_core::Error::NoEntry => Error::EntryNotFound,
            keyring_core::Error::Ambiguous(_) => Error::AmbiguousEntry,
            keyring_core::Error::Invalid(msg, _) => Error::InvalidInput(msg),
            keyring_core::Error::BadEncoding(_) => Error::InvalidUtf8,
            _ => Error::PlatformError(err.to_string()),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        Error::Io(err.to_string())
    }
}

#[cfg(mobile)]
impl From<tauri::plugin::mobile::PluginInvokeError> for Error {
    fn from(err: tauri::plugin::mobile::PluginInvokeError) -> Self {
        Error::PluginInvoke(err.to_string())
    }
}
