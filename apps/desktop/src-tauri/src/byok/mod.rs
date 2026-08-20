use crate::runtime::run_engine_command;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const KEYCHAIN_SERVICE: &str = "lyrashield";
const AZURE_ACCOUNT: &str = "azure-openai";

/// ChatGPT authentication status (delegated to the engine CLI).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum ChatGptAuthStatus {
    SignedIn,
    SignedOut,
    Error { message: String },
}

/// Azure OpenAI credentials stored in the OS keychain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AzureCredentials {
    pub api_key: String,
    pub endpoint: String,
}

/// Check ChatGPT auth status by spawning `lyrashield auth status`.
pub fn check_chatgpt_auth() -> ChatGptAuthStatus {
    let result = run_engine_command(&["auth".into(), "status".into()], &HashMap::new());

    if !result.success {
        // `auth status` returns non-zero when not signed in.
        return ChatGptAuthStatus::SignedOut;
    }

    // The engine prints "Signed in" or similar on success.
    if result.stdout.to_lowercase().contains("signed in") || result.stdout.contains("✓") {
        ChatGptAuthStatus::SignedIn
    } else {
        ChatGptAuthStatus::SignedOut
    }
}

/// Start the ChatGPT OAuth login flow by spawning `lyrashield auth login chatgpt`.
///
/// This opens a browser and blocks until the user completes the flow.
/// The engine stores the token at `~/.strix/subscription-auth.json`.
pub fn login_chatgpt() -> Result<(), String> {
    let result = run_engine_command(
        &["auth".into(), "login".into(), "chatgpt".into()],
        &HashMap::new(),
    );

    if result.success {
        Ok(())
    } else {
        let msg = if result.stderr.trim().is_empty() {
            &result.stdout
        } else {
            &result.stderr
        };
        Err(format!("ChatGPT login failed: {}", msg))
    }
}

/// Log out of ChatGPT by spawning `lyrashield auth logout`.
pub fn logout_chatgpt() -> Result<(), String> {
    let result = run_engine_command(&["auth".into(), "logout".into()], &HashMap::new());

    if result.success {
        Ok(())
    } else {
        Err(format!("ChatGPT logout failed: {}", result.stderr))
    }
}

/// Save Azure OpenAI credentials to the OS keychain.
pub fn save_azure_credentials(api_key: &str, endpoint: &str) -> Result<(), String> {
    let creds = serde_json::to_string(&AzureCredentials {
        api_key: api_key.to_string(),
        endpoint: endpoint.to_string(),
    })
    .map_err(|e| format!("failed to serialize azure creds: {}", e))?;

    let entry = Entry::new(KEYCHAIN_SERVICE, AZURE_ACCOUNT)
        .map_err(|e| format!("failed to create keychain entry: {}", e))?;
    entry
        .set_password(&creds)
        .map_err(|e| format!("failed to save azure creds to keychain: {}", e))
}

/// Load Azure OpenAI credentials from the OS keychain.
pub fn load_azure_credentials() -> Result<Option<AzureCredentials>, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, AZURE_ACCOUNT)
        .map_err(|e| format!("failed to create keychain entry: {}", e))?;

    match entry.get_password() {
        Ok(creds_str) => {
            let creds: AzureCredentials = serde_json::from_str(&creds_str)
                .map_err(|e| format!("failed to parse azure creds: {}", e))?;
            Ok(Some(creds))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("failed to read azure creds from keychain: {}", e)),
    }
}

/// Clear Azure OpenAI credentials from the OS keychain.
pub fn clear_azure_credentials() -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, AZURE_ACCOUNT)
        .map_err(|e| format!("failed to create keychain entry: {}", e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to clear azure creds: {}", e)),
    }
}
