use crate::models::{CredentialType, CredentialValue};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use keyring_core::Entry;
use std::sync::OnceLock;

static SERVICE_NAME: OnceLock<String> = OnceLock::new();

/// Lazily create the Android-native keyring_core store and register it as the default.
///
/// This must run *after* `ndk_context` has been initialized (which happens in
/// `KeyringPlugin.load()` on the Kotlin side once the WebView exists) — otherwise
/// `Store::new()` reads an uninitialized `ndk_context` and panics/aborts the process.
/// Keyring commands only run in response to a JS `invoke`, i.e. well after the WebView
/// (and thus `load()`/`initializeNdkContext`) exists, so calling this from `create_entry`
/// is safe. It is guarded so the store is created exactly once, and is retried on failure
/// (so a spurious early failure does not permanently poison the store).
#[cfg(target_os = "android")]
fn ensure_android_store() -> crate::Result<()> {
    use std::sync::Mutex;
    static INITIALIZED: Mutex<bool> = Mutex::new(false);
    let mut done = INITIALIZED.lock().unwrap();
    if *done {
        return Ok(());
    }
    let store = android_native_keyring_store::Store::new()
        .map_err(|e| crate::Error::PlatformError(e.to_string()))?;
    keyring_core::set_default_store(store);
    *done = true;
    Ok(())
}

pub struct KeyringImplementation;

impl KeyringImplementation {
    /// Initialize the service name for keyring entries
    pub fn initialize_service(service_name: String) -> crate::Result<()> {
        tauri_plugin_log::log::info!("Initializing keyring service: {}", service_name);
        SERVICE_NAME
            .set(service_name)
            .map_err(|_| crate::Error::InvalidInput("Service name already initialized".into()))?;
        Ok(())
    }

    /// Get the initialized service name
    fn get_service_name() -> crate::Result<&'static String> {
        SERVICE_NAME.get().ok_or(crate::Error::InvalidInput(
            "Service name not initialized".into(),
        ))
    }

    /// Create a keyring entry with the format: service_name/username/credential_type
    fn create_entry(username: &str, credential_type: &CredentialType) -> crate::Result<Entry> {
        // On Android the keyring_core store is created lazily on first use, once
        // `ndk_context` is available (see `ensure_android_store`). On desktop the store
        // is set eagerly in `desktop::init`, so this is Android-only.
        #[cfg(target_os = "android")]
        ensure_android_store()?;
        let service = Self::get_service_name()?;
        let entry_username = format!("{}/{}/{}", service, username, credential_type);
        tauri_plugin_log::log::debug!("Creating keyring entry for: {}", entry_username);
        Entry::new(service, &entry_username).map_err(Into::into)
    }

    /// Set a credential (password or secret)
    pub fn set(
        &self,
        username: &str,
        credential_type: CredentialType,
        value: CredentialValue,
    ) -> crate::Result<()> {
        tauri_plugin_log::log::debug!("Setting {} for user: {}", credential_type, username);
        let entry = Self::create_entry(username, &credential_type)?;

        match (credential_type, value) {
            (CredentialType::Password, CredentialValue::Password(password)) => {
                entry.set_password(&password).map_err(Into::into)
            }
            (CredentialType::Secret, CredentialValue::Secret(secret)) => {
                let encoded = BASE64.encode(&secret);
                entry.set_secret(encoded.as_bytes()).map_err(Into::into)
            }
            _ => Err(crate::Error::InvalidInput(
                "Credential type and value type mismatch".into(),
            )),
        }
    }

    /// Get a credential (password or secret)
    pub fn get(
        &self,
        username: &str,
        credential_type: CredentialType,
    ) -> crate::Result<CredentialValue> {
        tauri_plugin_log::log::debug!("Getting {} for user: {}", credential_type, username);
        let entry = Self::create_entry(username, &credential_type)?;

        match credential_type {
            CredentialType::Password => {
                let password = entry.get_password().map_err(crate::Error::from)?;
                Ok(CredentialValue::Password(password))
            }
            CredentialType::Secret => {
                let encoded_bytes = entry.get_secret().map_err(crate::Error::from)?;
                let encoded_str =
                    String::from_utf8(encoded_bytes).map_err(|_| crate::Error::InvalidUtf8)?;
                let secret = BASE64
                    .decode(encoded_str)
                    .map_err(|_| crate::Error::InvalidInput("Invalid base64 data".into()))?;
                Ok(CredentialValue::Secret(secret))
            }
        }
    }

    /// Delete a credential
    pub fn delete(&self, username: &str, credential_type: CredentialType) -> crate::Result<()> {
        tauri_plugin_log::log::debug!("Deleting {} for user: {}", credential_type, username);

        let entry = Self::create_entry(username, &credential_type)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring_core::Error::NoEntry) => {
                tauri_plugin_log::log::debug!("Entry already doesn't exist for user: {}", username);
                Ok(())
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Check if a credential exists
    pub fn exists(&self, username: &str, credential_type: CredentialType) -> crate::Result<bool> {
        tauri_plugin_log::log::debug!(
            "Checking existence of {} for user: {}",
            credential_type,
            username
        );
        let entry = Self::create_entry(username, &credential_type)?;
        match entry.get_credential() {
            Ok(_) => Ok(true),
            Err(keyring_core::Error::NoEntry) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CredentialType, CredentialValue};
    use keyring_core::mock::Store;
    use std::sync::{Mutex, Once};

    // For testing, we'll use a simpler approach where each test uses a unique service name
    static TEST_COUNTER: Mutex<u32> = Mutex::new(0);
    static INIT_MOCK_STORE: Once = Once::new();

    /// Setup function to initialize mock store for testing (only once)
    fn setup_mock_keyring() -> crate::Result<()> {
        INIT_MOCK_STORE.call_once(|| {
            let store = Store::new().expect("Failed to create mock store");
            keyring_core::set_default_store(store);
        });
        Ok(())
    }

    /// Setup function with unique service name initialized for each test
    fn setup_with_unique_service() -> crate::Result<String> {
        setup_mock_keyring()?;

        // Generate a unique service name for this test
        let mut counter = TEST_COUNTER.lock().unwrap();
        *counter += 1;
        let service_name = format!("com.test.app.{}", *counter);
        drop(counter);

        // Since we can't reset OnceLock, we need to work around this for testing
        // We'll create entries directly for testing
        Ok(service_name)
    }

    /// Create a test entry directly using the service name
    fn create_test_entry(
        service_name: &str,
        username: &str,
        credential_type: &CredentialType,
    ) -> crate::Result<Entry> {
        let entry_username = format!("{}/{}/{}", service_name, username, credential_type);
        Entry::new(service_name, &entry_username).map_err(Into::into)
    }

    /// Set credential for testing (bypasses static service name)
    fn test_set(
        service_name: &str,
        username: &str,
        credential_type: CredentialType,
        value: CredentialValue,
    ) -> crate::Result<()> {
        let entry = create_test_entry(service_name, username, &credential_type)?;

        match (credential_type, value) {
            (CredentialType::Password, CredentialValue::Password(password)) => {
                entry.set_password(&password).map_err(Into::into)
            }
            (CredentialType::Secret, CredentialValue::Secret(secret)) => {
                let encoded = BASE64.encode(&secret);
                entry.set_secret(encoded.as_bytes()).map_err(Into::into)
            }
            _ => Err(crate::Error::InvalidInput(
                "Credential type and value type mismatch".into(),
            )),
        }
    }

    /// Get credential for testing (bypasses static service name)
    fn test_get(
        service_name: &str,
        username: &str,
        credential_type: CredentialType,
    ) -> crate::Result<CredentialValue> {
        let entry = create_test_entry(service_name, username, &credential_type)?;

        match credential_type {
            CredentialType::Password => {
                let password = entry.get_password().map_err(|e| {
                    if matches!(e, keyring_core::Error::NoEntry) {
                        crate::Error::EntryNotFound
                    } else {
                        crate::Error::from(e)
                    }
                })?;
                Ok(CredentialValue::Password(password))
            }
            CredentialType::Secret => {
                let encoded = entry.get_secret().map_err(|e| {
                    if matches!(e, keyring_core::Error::NoEntry) {
                        crate::Error::EntryNotFound
                    } else {
                        crate::Error::from(e)
                    }
                })?;
                let secret = BASE64.decode(&encoded).map_err(|e| {
                    crate::Error::InvalidInput(format!("Base64 decode error: {}", e))
                })?;
                Ok(CredentialValue::Secret(secret))
            }
        }
    }

    /// Delete credential for testing (bypasses static service name)
    fn test_delete(
        service_name: &str,
        username: &str,
        credential_type: CredentialType,
    ) -> crate::Result<()> {
        let entry = create_test_entry(service_name, username, &credential_type)?;

        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring_core::Error::NoEntry) => Ok(()), // Already deleted
            Err(e) => Err(crate::Error::from(e)),
        }
    }

    /// Check if credential exists for testing (bypasses static service name)
    fn test_exists(
        service_name: &str,
        username: &str,
        credential_type: CredentialType,
    ) -> crate::Result<bool> {
        match test_get(service_name, username, credential_type) {
            Ok(_) => Ok(true),
            Err(crate::Error::EntryNotFound) => Ok(false),
            Err(e) => Err(e),
        }
    }

    #[test]
    fn test_set_and_get_password() {
        let service_name = setup_with_unique_service().unwrap();
        let username = "testuser";
        let password = "supersecret123";

        // Test setting password
        let result = test_set(
            &service_name,
            username,
            CredentialType::Password,
            CredentialValue::Password(password.to_string()),
        );
        assert!(result.is_ok());

        // Test getting password
        let retrieved = test_get(&service_name, username, CredentialType::Password).unwrap();
        match retrieved {
            CredentialValue::Password(retrieved_password) => {
                assert_eq!(retrieved_password, password);
            }
            _ => panic!("Expected password, got secret"),
        }
    }

    #[test]
    fn test_set_and_get_secret() {
        let service_name = setup_with_unique_service().unwrap();
        let username = "testuser";
        let secret_data = vec![0x01, 0x02, 0x03, 0xFF, 0xAB];

        // Test setting secret
        let result = test_set(
            &service_name,
            username,
            CredentialType::Secret,
            CredentialValue::Secret(secret_data.clone()),
        );
        assert!(result.is_ok());

        // Test getting secret
        let retrieved = test_get(&service_name, username, CredentialType::Secret).unwrap();
        match retrieved {
            CredentialValue::Secret(retrieved_secret) => {
                assert_eq!(retrieved_secret, secret_data);
            }
            _ => panic!("Expected secret, got password"),
        }
    }

    #[test]
    fn test_credential_type_mismatch() {
        let service_name = setup_with_unique_service().unwrap();

        // Test that we get an error when types don't match
        let result = test_set(
            &service_name,
            "testuser",
            CredentialType::Password,
            CredentialValue::Secret(vec![1, 2, 3]),
        );
        assert!(result.is_err());

        let result = test_set(
            &service_name,
            "testuser",
            CredentialType::Secret,
            CredentialValue::Password("test".to_string()),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_mutually_exclusive_credentials() {
        let service_name = setup_with_unique_service().unwrap();
        let username = "testuser";

        // Set a password
        test_set(
            &service_name,
            username,
            CredentialType::Password,
            CredentialValue::Password("password123".to_string()),
        )
        .unwrap();

        // Set a secret for the same user (should be separate entries)
        test_set(
            &service_name,
            username,
            CredentialType::Secret,
            CredentialValue::Secret(vec![1, 2, 3]),
        )
        .unwrap();

        // Both should exist independently
        assert!(test_exists(&service_name, username, CredentialType::Password).unwrap());
        assert!(test_exists(&service_name, username, CredentialType::Secret).unwrap());

        // Both should be retrievable
        let password_result = test_get(&service_name, username, CredentialType::Password);
        let secret_result = test_get(&service_name, username, CredentialType::Secret);

        assert!(password_result.is_ok());
        assert!(secret_result.is_ok());
    }

    #[test]
    fn test_exists_functionality() {
        let service_name = setup_with_unique_service().unwrap();
        let username = "testuser";

        // Initially should not exist
        assert!(!test_exists(&service_name, username, CredentialType::Password).unwrap());
        assert!(!test_exists(&service_name, username, CredentialType::Secret).unwrap());

        // Set a password
        test_set(
            &service_name,
            username,
            CredentialType::Password,
            CredentialValue::Password("test".to_string()),
        )
        .unwrap();

        // Password should exist, secret should not
        assert!(test_exists(&service_name, username, CredentialType::Password).unwrap());
        assert!(!test_exists(&service_name, username, CredentialType::Secret).unwrap());
    }

    #[test]
    fn test_delete_functionality() {
        let service_name = setup_with_unique_service().unwrap();
        let username = "testuser";

        // Set a password
        test_set(
            &service_name,
            username,
            CredentialType::Password,
            CredentialValue::Password("test".to_string()),
        )
        .unwrap();

        // Verify it exists
        assert!(test_exists(&service_name, username, CredentialType::Password).unwrap());

        // Delete it
        assert!(test_delete(&service_name, username, CredentialType::Password).is_ok());

        // Verify it no longer exists
        assert!(!test_exists(&service_name, username, CredentialType::Password).unwrap());

        // Deleting again should succeed (idempotent)
        assert!(test_delete(&service_name, username, CredentialType::Password).is_ok());
    }

    #[test]
    fn test_delete_nonexistent_credential() {
        let service_name = setup_with_unique_service().unwrap();

        // Deleting non-existent credential should succeed
        assert!(test_delete(&service_name, "nonexistent", CredentialType::Password).is_ok());
        assert!(test_delete(&service_name, "nonexistent", CredentialType::Secret).is_ok());
    }

    #[test]
    fn test_get_nonexistent_credential() {
        let service_name = setup_with_unique_service().unwrap();

        // Getting non-existent credential should return EntryNotFound
        let result = test_get(&service_name, "nonexistent", CredentialType::Password);
        assert!(result.is_err());
        match result.unwrap_err() {
            crate::Error::EntryNotFound => {}
            _ => panic!("Expected EntryNotFound error"),
        }
    }

    #[test]
    fn test_base64_encoding_for_secrets() {
        let service_name = setup_with_unique_service().unwrap();
        let username = "testuser";

        // Test with binary data that would be problematic as UTF-8
        let binary_data = vec![0x00, 0xFF, 0x80, 0x7F, 0xC0, 0x3F];

        test_set(
            &service_name,
            username,
            CredentialType::Secret,
            CredentialValue::Secret(binary_data.clone()),
        )
        .unwrap();

        let retrieved = test_get(&service_name, username, CredentialType::Secret).unwrap();
        match retrieved {
            CredentialValue::Secret(retrieved_data) => {
                assert_eq!(retrieved_data, binary_data);
            }
            _ => panic!("Expected secret"),
        }
    }

    #[test]
    fn test_multiple_users() {
        let service_name = setup_with_unique_service().unwrap();

        // Set credentials for multiple users
        test_set(
            &service_name,
            "user1",
            CredentialType::Password,
            CredentialValue::Password("pass1".to_string()),
        )
        .unwrap();
        test_set(
            &service_name,
            "user2",
            CredentialType::Password,
            CredentialValue::Password("pass2".to_string()),
        )
        .unwrap();
        test_set(
            &service_name,
            "user3",
            CredentialType::Secret,
            CredentialValue::Secret(vec![1, 2, 3]),
        )
        .unwrap();

        // Verify all exist independently
        assert!(test_exists(&service_name, "user1", CredentialType::Password).unwrap());
        assert!(test_exists(&service_name, "user2", CredentialType::Password).unwrap());
        assert!(test_exists(&service_name, "user3", CredentialType::Secret).unwrap());

        // Verify correct retrieval
        match test_get(&service_name, "user1", CredentialType::Password).unwrap() {
            CredentialValue::Password(pass) => assert_eq!(pass, "pass1"),
            _ => panic!("Expected password"),
        }

        match test_get(&service_name, "user2", CredentialType::Password).unwrap() {
            CredentialValue::Password(pass) => assert_eq!(pass, "pass2"),
            _ => panic!("Expected password"),
        }
    }

    #[test]
    fn test_service_name_formatting() {
        let service_name = setup_with_unique_service().unwrap();
        let username = "testuser";

        // This test verifies that our service name formatting works correctly
        // The actual service key should be service_name and username should be
        // formatted as "service_name/testuser/password" or "service_name/testuser/secret"

        test_set(
            &service_name,
            username,
            CredentialType::Password,
            CredentialValue::Password("test".to_string()),
        )
        .unwrap();

        // If our formatting is correct, this should work
        assert!(test_exists(&service_name, username, CredentialType::Password).unwrap());
    }

    #[test]
    fn test_static_service_initialization() {
        setup_mock_keyring().unwrap();

        // Test that we can only initialize once
        assert!(
            KeyringImplementation::initialize_service("com.test.app.static1".to_string()).is_ok()
        );

        // Second initialization should fail
        assert!(
            KeyringImplementation::initialize_service("com.test.app.static2".to_string()).is_err()
        );
    }

    #[test]
    fn test_uninitialized_service() {
        setup_mock_keyring().unwrap();
        let keyring = KeyringImplementation;

        // Operations should fail if service is not initialized (and we haven't initialized it in this test)
        // Note: Since other tests may have initialized the global service, we'll test the error condition
        // by checking that get_service_name works after initialization

        // This test is tricky because of the global state, so let's just verify the error message format
        match KeyringImplementation::get_service_name() {
            Ok(_) => {
                // Service was already initialized by another test, which is fine
                // Let's test that operations work
                let result = keyring.set(
                    "testuser",
                    CredentialType::Password,
                    CredentialValue::Password("test".to_string()),
                );
                // Should work since service is initialized
                assert!(result.is_ok());
            }
            Err(crate::Error::InvalidInput(msg)) => {
                assert_eq!(msg, "Service name not initialized");
            }
            Err(_) => panic!("Unexpected error type"),
        }
    }
}
