use crate::runtime::run_engine_command;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const KEYCHAIN_SERVICE: &str = "lyrashield";
const AZURE_ACCOUNT: &str = "azure-openai";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum ChatGptAuthStatus {
    SignedIn,
    SignedOut,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AzureCredentials {
    pub api_key: String,
    pub endpoint: String,
}

/// Metadata only — never exposes raw secrets to React.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AzureMetadata {
    pub configured: bool,
    pub endpoint: Option<String>,
    pub key_masked: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ByokStatus {
    pub chatgpt: ChatGptAuthStatus,
    pub azure: AzureMetadata,
}

pub fn check_chatgpt_auth() -> ChatGptAuthStatus {
    let result = run_engine_command(&["auth".into(), "status".into()], &HashMap::new());
    if !result.success {
        return ChatGptAuthStatus::SignedOut;
    }
    if result.stdout.to_lowercase().contains("signed in") || result.stdout.contains("✓") {
        ChatGptAuthStatus::SignedIn
    } else {
        ChatGptAuthStatus::SignedOut
    }
}

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

pub fn logout_chatgpt() -> Result<(), String> {
    let result = run_engine_command(&["auth".into(), "logout".into()], &HashMap::new());
    if result.success {
        Ok(())
    } else {
        Err(format!("ChatGPT logout failed: {}", result.stderr))
    }
}

fn mask_key(key: &str) -> String {
    if key.len() <= 8 {
        return "***".to_string();
    }
    let start = &key[..4];
    let end = &key[key.len() - 4..];
    format!("{}…{}", start, end)
}

fn validate_azure_endpoint(endpoint: &str) -> Result<(), String> {
    let e = endpoint.trim();
    if e.is_empty() {
        return Err("endpoint is empty".into());
    }
    let url = reqwest::Url::parse(e).map_err(|_| "endpoint is not a valid URL".to_string())?;
    if url.scheme() != "https" {
        return Err("endpoint must be https://".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "endpoint must not contain credentials, a custom port, query, or fragment".into(),
        );
    }
    let host = url.host_str().unwrap_or_default();
    let trusted_host = host
        .strip_suffix(".openai.azure.com")
        .or_else(|| host.strip_suffix(".openai.azure.us"))
        .is_some_and(|resource| !resource.is_empty() && !resource.contains('.'));
    if !trusted_host {
        return Err("endpoint must be an Azure OpenAI endpoint".into());
    }
    Ok(())
}

pub fn validate_azure_credentials(api_key: &str, endpoint: &str) -> Result<(), String> {
    if api_key.trim().len() < 8 {
        return Err("API key too short".into());
    }
    validate_azure_endpoint(endpoint)?;
    Ok(())
}

/// Save Azure credentials — native validation before persisting, never logs raw key.
pub fn save_azure_credentials(api_key: &str, endpoint: &str) -> Result<(), String> {
    validate_azure_credentials(api_key, endpoint)?;
    let creds = serde_json::to_string(&AzureCredentials {
        api_key: api_key.to_string(),
        endpoint: endpoint.trim().to_string(),
    })
    .map_err(|e| format!("failed to serialize azure creds: {}", e))?;
    let entry = Entry::new(KEYCHAIN_SERVICE, AZURE_ACCOUNT)
        .map_err(|e| format!("failed to create keychain entry: {}", e))?;
    entry
        .set_password(&creds)
        .map_err(|e| format!("failed to save azure creds to keychain: {}", e))
}

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

pub fn clear_azure_credentials() -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, AZURE_ACCOUNT)
        .map_err(|e| format!("failed to create keychain entry: {}", e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to clear azure creds: {}", e)),
    }
}

/// Metadata-only view for React — never returns raw api_key.
pub fn get_azure_metadata() -> Result<AzureMetadata, String> {
    match load_azure_credentials()? {
        Some(creds) => {
            // Validate stored creds natively before reporting ready
            let valid = validate_azure_credentials(&creds.api_key, &creds.endpoint).is_ok();
            Ok(AzureMetadata {
                configured: valid,
                endpoint: Some(creds.endpoint),
                key_masked: Some(mask_key(&creds.api_key)),
            })
        }
        None => Ok(AzureMetadata {
            configured: false,
            endpoint: None,
            key_masked: None,
        }),
    }
}

pub fn get_byok_status() -> Result<ByokStatus, String> {
    let chatgpt = check_chatgpt_auth();
    let azure = get_azure_metadata()?;
    Ok(ByokStatus { chatgpt, azure })
}

/// Ensure at least one BYOK provider is configured — used to fail before scan creation.
pub fn require_byok_ready() -> Result<(), String> {
    let status = get_byok_status()?;
    let chat_ready = matches!(status.chatgpt, ChatGptAuthStatus::SignedIn);
    if chat_ready || status.azure.configured {
        Ok(())
    } else {
        Err("BYOK not configured — setup required".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn masked_never_contains_full_key() {
        let key = "test-key-for-masking-1234567890"; // gitleaks:allow
        let masked = mask_key(key);
        assert!(!masked.contains(key));
        assert!(masked.contains("…") || masked.contains("***"));
    }
    #[test]
    fn metadata_never_exposes_key() {
        // Save and get metadata path should not ceil raw key; we test mask logic
        let meta = AzureMetadata {
            configured: true,
            endpoint: Some("https://foo.openai.azure.com".into()),
            key_masked: Some(mask_key("test-key-abcdef-123456")), // gitleaks:allow
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(!json.contains("test-key-abcdef-123456"));
    }
    #[test]
    fn endpoint_validation_rejects_non_https() {
        assert!(validate_azure_endpoint("http://bad").is_err());
        assert!(validate_azure_endpoint("https://my.openai.azure.com").is_ok());
        assert!(validate_azure_endpoint("https://openai.azure.com").is_err());
        assert!(validate_azure_endpoint("https://openai.azure.us").is_err());
        assert!(validate_azure_endpoint("https://nested.my.openai.azure.com").is_err());
        assert!(validate_azure_endpoint("https://openai.azure.com.attacker.example").is_err());
        assert!(validate_azure_endpoint("https://attacker@my.openai.azure.com").is_err());
        assert!(validate_azure_endpoint("https://my.openai.azure.com:8443").is_err());
    }
}
