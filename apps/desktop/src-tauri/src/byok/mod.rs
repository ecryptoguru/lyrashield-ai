use crate::runtime::run_engine_command;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const KEYCHAIN_SERVICE: &str = "lyrashield";
const AZURE_ACCOUNT: &str = "azure-openai";
const PROVIDER_ACCOUNT: &str = "byok-provider";

/// The BYOK provider the user explicitly selected in Setup. Stored through the
/// same native keychain boundary as the credentials so the scan-time resolver
/// never has to guess from credential presence alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ByokProvider {
    ChatGpt,
    Azure,
}

impl ByokProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            ByokProvider::ChatGpt => "chatgpt",
            ByokProvider::Azure => "azure",
        }
    }

    /// Normalize a stored selection token; unrecognized values are no
    /// selection — never a silent provider guess.
    fn from_stored(raw: &str) -> Option<ByokProvider> {
        match raw.trim() {
            "chatgpt" => Some(ByokProvider::ChatGpt),
            "azure" => Some(ByokProvider::Azure),
            _ => None,
        }
    }
}

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
    /// Deployment identity for the `azure/<deployment>` engine route. Records
    /// written before deployment capture deserialize as empty and fail
    /// validation — the scan resolver never routes on a missing deployment.
    #[serde(default)]
    pub deployment: String,
}

/// Metadata only — never exposes raw secrets to React.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureMetadata {
    pub configured: bool,
    pub endpoint: Option<String>,
    pub deployment: Option<String>,
    pub key_masked: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ByokStatus {
    pub chatgpt: ChatGptAuthStatus,
    pub azure: AzureMetadata,
    /// The provider recorded as selected; `None` before Setup picks one.
    pub selected: Option<ByokProvider>,
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
        // A successful interactive sign-in is an explicit provider choice.
        store_selected_provider(ByokProvider::ChatGpt)?;
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
    if !result.success {
        return Err(format!("ChatGPT logout failed: {}", result.stderr));
    }
    // Signing out the selected provider clears the selection — the resolver
    // must never route a scan through an identity that no longer exists.
    if load_selected_provider()? == Some(ByokProvider::ChatGpt) {
        clear_selected_provider()?;
    }
    Ok(())
}

fn mask_key(key: &str) -> String {
    // VULN-F-004: byte-slicing (&key[..4]) panics mid-multibyte-char. Count
    // and slice on char boundaries instead.
    let len = key.chars().count();
    if len <= 8 {
        return "***".to_string();
    }
    let start: String = key.chars().take(4).collect();
    let end: String = key.chars().skip(len - 4).collect();
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

/// Normalize a configured Azure deployment onto the engine's model gate.
/// Only the GPT-6 Sol/Luna identities are admitted — an arbitrary deployment
/// string is rejected rather than relaxing policy. The canonical `azure/`
/// route prefix is accepted and stripped.
pub fn normalize_azure_deployment(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().to_ascii_lowercase().replace('_', "-");
    let name = normalized.strip_prefix("azure/").unwrap_or(&normalized);
    match name {
        "gpt-6-sol" | "gpt-6-luna" => Ok(name.to_string()),
        _ => Err(
            "Azure deployment must be a gpt-6-sol or gpt-6-luna deployment — the engine model-name gate rejects arbitrary deployment strings".into(),
        ),
    }
}

pub fn validate_azure_credentials(
    api_key: &str,
    endpoint: &str,
    deployment: &str,
) -> Result<(), String> {
    if api_key.trim().len() < 8 {
        return Err("API key too short".into());
    }
    // VULN-F-004: Azure API keys are ASCII; a multibyte key would also panic
    // the status/metadata masker on every read.
    if !api_key.is_ascii() {
        return Err("API key must be ASCII".into());
    }
    validate_azure_endpoint(endpoint)?;
    // Deployment identity is part of the route — a missing or off-policy name
    // is a configuration failure, not a fallback to some default model.
    normalize_azure_deployment(deployment)?;
    Ok(())
}

/// Save Azure credentials — native validation before persisting, never logs raw key.
/// Saving is an explicit provider choice, so Azure becomes the selected provider.
pub fn save_azure_credentials(
    api_key: &str,
    endpoint: &str,
    deployment: &str,
) -> Result<(), String> {
    validate_azure_credentials(api_key, endpoint, deployment)?;
    let creds = serde_json::to_string(&AzureCredentials {
        api_key: api_key.to_string(),
        endpoint: endpoint.trim().to_string(),
        deployment: normalize_azure_deployment(deployment)?,
    })
    .map_err(|e| format!("failed to serialize azure creds: {}", e))?;
    let entry = Entry::new(KEYCHAIN_SERVICE, AZURE_ACCOUNT)
        .map_err(|e| format!("failed to create keychain entry: {}", e))?;
    entry
        .set_password(&creds)
        .map_err(|e| format!("failed to save azure creds to keychain: {}", e))?;
    store_selected_provider(ByokProvider::Azure)
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
        Ok(()) => {}
        Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(format!("failed to clear azure creds: {}", e)),
    }
    // Removing the selected provider's credentials clears the selection too.
    if load_selected_provider()? == Some(ByokProvider::Azure) {
        clear_selected_provider()?;
    }
    Ok(())
}

/// Read the Setup-recorded provider selection. `None` means no selection was
/// ever stored (or the stored token was unrecognized — never a guess).
pub fn load_selected_provider() -> Result<Option<ByokProvider>, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, PROVIDER_ACCOUNT)
        .map_err(|e| format!("failed to create keychain entry: {}", e))?;
    match entry.get_password() {
        Ok(raw) => Ok(ByokProvider::from_stored(&raw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("failed to read provider selection: {}", e)),
    }
}

fn store_selected_provider(provider: ByokProvider) -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, PROVIDER_ACCOUNT)
        .map_err(|e| format!("failed to create keychain entry: {}", e))?;
    entry
        .set_password(provider.as_str())
        .map_err(|e| format!("failed to store provider selection: {}", e))
}

fn clear_selected_provider() -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, PROVIDER_ACCOUNT)
        .map_err(|e| format!("failed to create keychain entry: {}", e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to clear provider selection: {}", e)),
    }
}

/// Explicit user action: make an already-configured provider the selected
/// route. Selecting an unconfigured provider fails closed — the selection must
/// always name a provider whose credentials are actually usable.
pub fn set_selected_provider(provider: &str) -> Result<(), String> {
    let parsed = ByokProvider::from_stored(provider).ok_or("unknown BYOK provider")?;
    match parsed {
        ByokProvider::ChatGpt => {
            if !matches!(check_chatgpt_auth(), ChatGptAuthStatus::SignedIn) {
                return Err("ChatGPT is not signed in — connect it first".into());
            }
        }
        ByokProvider::Azure => {
            let usable = load_azure_credentials()?
                .map(|c| validate_azure_credentials(&c.api_key, &c.endpoint, &c.deployment).is_ok())
                .unwrap_or(false);
            if !usable {
                return Err("Azure OpenAI is not configured — save valid credentials first".into());
            }
        }
    }
    store_selected_provider(parsed)
}

/// Metadata-only view for React — never returns raw api_key.
pub fn get_azure_metadata() -> Result<AzureMetadata, String> {
    match load_azure_credentials()? {
        Some(creds) => {
            // Validate stored creds natively before reporting ready — including
            // the deployment identity the engine route is built from.
            let valid =
                validate_azure_credentials(&creds.api_key, &creds.endpoint, &creds.deployment)
                    .is_ok();
            Ok(AzureMetadata {
                configured: valid,
                endpoint: Some(creds.endpoint),
                deployment: normalize_azure_deployment(&creds.deployment).ok(),
                key_masked: Some(mask_key(&creds.api_key)),
            })
        }
        None => Ok(AzureMetadata {
            configured: false,
            endpoint: None,
            deployment: None,
            key_masked: None,
        }),
    }
}

pub fn get_byok_status() -> Result<ByokStatus, String> {
    let chatgpt = check_chatgpt_auth();
    let azure = get_azure_metadata()?;
    let selected = load_selected_provider()?;
    Ok(ByokStatus {
        chatgpt,
        azure,
        selected,
    })
}

/// Resolve the selected provider into the explicit model/credential env for
/// the engine child. Pure: takes already-loaded credential state so routing is
/// testable without keychain or engine access. Error messages never contain
/// key material.
pub fn resolve_provider_env(
    selection: Option<ByokProvider>,
    chatgpt: &ChatGptAuthStatus,
    azure: Option<&AzureCredentials>,
) -> Result<HashMap<String, String>, String> {
    let chatgpt_ready = matches!(chatgpt, ChatGptAuthStatus::SignedIn);
    let azure_ready = azure.is_some_and(|creds| {
        validate_azure_credentials(&creds.api_key, &creds.endpoint, &creds.deployment).is_ok()
    });
    // Resolve deterministically: honor the recorded selection exactly, and
    // only infer for legacy installs where precisely one provider is usable —
    // credential presence alone must never pick a provider, or a user with
    // both configured would get an accidental Azure override.
    let provider = match selection {
        Some(selected) => selected,
        None => match (chatgpt_ready, azure_ready) {
            (true, true) => {
                return Err(
                    "Both ChatGPT and Azure OpenAI are configured — select a provider in Setup"
                        .into(),
                )
            }
            (true, false) => ByokProvider::ChatGpt,
            (false, true) => ByokProvider::Azure,
            (false, false) => {
                return Err("BYOK not configured — connect ChatGPT or Azure OpenAI in Setup".into())
            }
        },
    };
    let mut env = HashMap::new();
    match provider {
        ByokProvider::ChatGpt => {
            if !chatgpt_ready {
                return Err(
                    "ChatGPT is the selected provider but the engine subscription is not signed in"
                        .into(),
                );
            }
            // Subscription auth is admitted on Local for the root model only:
            // the engine documents subscription support for the main model and
            // restricts explicit delegate/dedupe subscription configuration, so
            // no LYRASHIELD_DELEGATE_* or specialist override is emitted here.
            env.insert(
                "LYRASHIELD_LLM".to_string(),
                "chatgpt/gpt-6-luna".to_string(),
            );
            env.insert(
                "LYRASHIELD_ALLOW_CHATGPT_SUBSCRIPTION".to_string(),
                "1".to_string(),
            );
        }
        ByokProvider::Azure => {
            if !azure_ready {
                return Err(
                    "Azure OpenAI is the selected provider but its credentials or deployment are missing or invalid"
                        .into(),
                );
            }
            let creds = azure.expect("azure_ready implies credentials are present");
            // azure_ready already ran the gate — this cannot fail.
            let deployment = normalize_azure_deployment(&creds.deployment)?;
            let route = format!("azure/{deployment}");
            env.insert("AZURE_OPENAI_API_KEY".to_string(), creds.api_key.clone());
            env.insert("AZURE_OPENAI_ENDPOINT".to_string(), creds.endpoint.clone());
            // Provider endpoint/API-version mapping: the `azure/` route reads
            // the OpenAI-compatible endpoint plus the shared v1 API version.
            env.insert("AZURE_API_VERSION".to_string(), "v1".to_string());
            // The engine needs every specialist lane resolvable — one root
            // variable alone does not make the full scan valid. The key-based
            // Azure route can serve delegate/dedupe lanes, so pin them to the
            // same admitted deployment identity.
            env.insert("LYRASHIELD_LLM".to_string(), route.clone());
            env.insert("LYRASHIELD_DELEGATE_LLM".to_string(), route);
            // Subscription auth stays pinned off on the key-based route — the
            // same explicit pin the hosted worker applies.
            env.insert(
                "LYRASHIELD_ALLOW_CHATGPT_SUBSCRIPTION".to_string(),
                "0".to_string(),
            );
        }
    }
    Ok(env)
}

/// IO wrapper around `resolve_provider_env` — reads credential state through
/// the keychain boundary and the engine's own auth status. Never logs values.
pub fn resolve_byok_env() -> Result<HashMap<String, String>, String> {
    let chatgpt = check_chatgpt_auth();
    let azure = load_azure_credentials()?;
    let selection = load_selected_provider()?;
    resolve_provider_env(selection, &chatgpt, azure.as_ref())
}

/// Ensure the selected BYOK provider actually resolves — used to fail before
/// scan creation.
pub fn require_byok_ready() -> Result<(), String> {
    resolve_byok_env().map(|_| ())
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
            deployment: Some("gpt-6-luna".into()),
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

    // VULN-F-004: byte-slicing panicked mid-multibyte char — mask must be
    // boundary-safe and validation must refuse non-ASCII keys.
    #[test]
    fn mask_key_is_utf8_boundary_safe() {
        let key = "キー-🔑-αβγδ-test"; // gitleaks:allow — not a credential
        let masked = mask_key(key);
        assert!(masked.contains("…"));
        assert!(masked.starts_with("キー-"));
        assert!(masked.ends_with("st") || masked.ends_with("est"));
    }

    #[test]
    fn azure_credentials_reject_multibyte_key() {
        assert!(validate_azure_credentials(
            "キー-🔑-αβγδ-1234",
            "https://my.openai.azure.com",
            "gpt-6-luna"
        )
        .is_err());
        assert!(validate_azure_credentials(
            "plain-ascii-key-123",
            "https://my.openai.azure.com",
            "gpt-6-luna"
        )
        .is_ok());
    }

    // W6.1 — deterministic provider resolution and the engine model gate.

    fn azure_creds(deployment: &str) -> AzureCredentials {
        AzureCredentials {
            api_key: "azure-test-key-000000".to_string(), // gitleaks:allow — fixture only
            endpoint: "https://my.openai.azure.com".to_string(),
            deployment: deployment.to_string(),
        }
    }

    #[test]
    fn deployment_gate_admits_only_gpt6_sol_and_luna() {
        assert_eq!(
            normalize_azure_deployment("gpt-6-luna").unwrap(),
            "gpt-6-luna"
        );
        assert_eq!(
            normalize_azure_deployment("GPT_6_SOL").unwrap(),
            "gpt-6-sol"
        );
        assert_eq!(
            normalize_azure_deployment("azure/gpt-6-luna").unwrap(),
            "gpt-6-luna"
        );
        assert_eq!(
            normalize_azure_deployment("  gpt-6-luna  ").unwrap(),
            "gpt-6-luna"
        );
        // Arbitrary deployment names never relax GPT-6 policy.
        for bad in [
            "",
            "my-deployment",
            "gpt-4o",
            "gpt-6-luna-extra",
            "openai/gpt-6-luna",
            "azure/foo/gpt-6-luna",
        ] {
            assert!(
                normalize_azure_deployment(bad).is_err(),
                "deployment {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn chatgpt_selection_produces_subscription_route_only() {
        let env = resolve_provider_env(
            Some(ByokProvider::ChatGpt),
            &ChatGptAuthStatus::SignedIn,
            None,
        )
        .unwrap();
        assert_eq!(env["LYRASHIELD_LLM"], "chatgpt/gpt-6-luna");
        assert_eq!(env["LYRASHIELD_ALLOW_CHATGPT_SUBSCRIPTION"], "1");
        // Subscription auth is documented for the main model only — no
        // delegate/dedupe or API-key variables may be emitted on this route.
        assert!(!env.contains_key("LYRASHIELD_DELEGATE_LLM"));
        assert!(!env.keys().any(|k| k.starts_with("AZURE_")));
        assert!(!env.keys().any(|k| k.starts_with("OPENAI_")));
        assert!(!env.keys().any(|k| k.starts_with("LLM_API_")));
    }

    #[test]
    fn azure_selection_produces_explicit_azure_route() {
        let creds = azure_creds("gpt-6-luna");
        let env = resolve_provider_env(
            Some(ByokProvider::Azure),
            &ChatGptAuthStatus::SignedOut,
            Some(&creds),
        )
        .unwrap();
        assert_eq!(env["LYRASHIELD_LLM"], "azure/gpt-6-luna");
        assert_eq!(env["LYRASHIELD_DELEGATE_LLM"], "azure/gpt-6-luna");
        assert_eq!(env["AZURE_OPENAI_API_KEY"], creds.api_key);
        assert_eq!(env["AZURE_OPENAI_ENDPOINT"], creds.endpoint);
        assert_eq!(env["AZURE_API_VERSION"], "v1");
        // The key-based route keeps subscription auth pinned off.
        assert_eq!(env["LYRASHIELD_ALLOW_CHATGPT_SUBSCRIPTION"], "0");
        assert!(!env["LYRASHIELD_LLM"].starts_with("chatgpt/"));
    }

    #[test]
    fn both_providers_configured_respect_each_explicit_selection() {
        let creds = azure_creds("gpt-6-luna");
        // The old resolver prioritized credential presence — with ChatGPT
        // selected, no AZURE_* variables may reach the child at all.
        let env = resolve_provider_env(
            Some(ByokProvider::ChatGpt),
            &ChatGptAuthStatus::SignedIn,
            Some(&creds),
        )
        .unwrap();
        assert_eq!(env["LYRASHIELD_LLM"], "chatgpt/gpt-6-luna");
        assert!(!env.keys().any(|k| k.starts_with("AZURE_")));
        assert!(!env.values().any(|v| v.contains(&creds.api_key)));

        let env = resolve_provider_env(
            Some(ByokProvider::Azure),
            &ChatGptAuthStatus::SignedIn,
            Some(&creds),
        )
        .unwrap();
        assert_eq!(env["LYRASHIELD_LLM"], "azure/gpt-6-luna");
        assert_eq!(env["LYRASHIELD_ALLOW_CHATGPT_SUBSCRIPTION"], "0");
    }

    #[test]
    fn missing_selection_is_inferred_only_when_unambiguous() {
        let creds = azure_creds("gpt-6-luna");
        // Both configured but no recorded selection — never a credential-
        // presence coin flip.
        assert!(resolve_provider_env(None, &ChatGptAuthStatus::SignedIn, Some(&creds)).is_err());
        assert!(resolve_provider_env(None, &ChatGptAuthStatus::SignedOut, None).is_err());
        // Exactly one usable provider is unambiguous for legacy installs.
        let env = resolve_provider_env(None, &ChatGptAuthStatus::SignedOut, Some(&creds)).unwrap();
        assert_eq!(env["LYRASHIELD_LLM"], "azure/gpt-6-luna");
        let env = resolve_provider_env(None, &ChatGptAuthStatus::SignedIn, None).unwrap();
        assert_eq!(env["LYRASHIELD_LLM"], "chatgpt/gpt-6-luna");
    }

    #[test]
    fn selected_provider_without_usable_credentials_fails_closed() {
        let creds = azure_creds("gpt-6-luna");
        assert!(resolve_provider_env(
            Some(ByokProvider::ChatGpt),
            &ChatGptAuthStatus::SignedOut,
            Some(&creds)
        )
        .is_err());
        assert!(resolve_provider_env(
            Some(ByokProvider::Azure),
            &ChatGptAuthStatus::SignedIn,
            None
        )
        .is_err());
    }

    #[test]
    fn missing_or_off_policy_deployment_fails_closed() {
        for deployment in ["", "my-custom-deploy", "gpt-4o"] {
            let creds = azure_creds(deployment);
            assert!(
                resolve_provider_env(
                    Some(ByokProvider::Azure),
                    &ChatGptAuthStatus::SignedOut,
                    Some(&creds)
                )
                .is_err(),
                "deployment {deployment:?} must not resolve"
            );
        }
        // A stored credential without a deployment is not "configured" — with
        // no selection it cannot count as the inferred provider either.
        let legacy = azure_creds("");
        assert!(resolve_provider_env(None, &ChatGptAuthStatus::SignedOut, Some(&legacy)).is_err());
    }

    #[test]
    fn resolver_errors_and_env_never_echo_key_material() {
        let creds = azure_creds("bad-deployment-name");
        for result in [
            resolve_provider_env(
                Some(ByokProvider::Azure),
                &ChatGptAuthStatus::SignedOut,
                Some(&creds),
            ),
            // No usable provider at all — the invalid Azure record cannot be
            // inferred and nothing else is signed in.
            resolve_provider_env(None, &ChatGptAuthStatus::SignedOut, Some(&creds)),
        ] {
            let err = result.unwrap_err();
            assert!(!err.contains(&creds.api_key), "error leaked key: {err}");
            assert!(
                !err.contains(&creds.endpoint),
                "error echoed endpoint: {err}"
            );
        }
        // The env map carries only the resolved routing/credential keys.
        let ok = resolve_provider_env(
            Some(ByokProvider::Azure),
            &ChatGptAuthStatus::SignedOut,
            Some(&azure_creds("gpt-6-sol")),
        )
        .unwrap();
        let mut keys: Vec<&str> = ok.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "AZURE_API_VERSION",
                "AZURE_OPENAI_API_KEY",
                "AZURE_OPENAI_ENDPOINT",
                "LYRASHIELD_ALLOW_CHATGPT_SUBSCRIPTION",
                "LYRASHIELD_DELEGATE_LLM",
                "LYRASHIELD_LLM",
            ]
        );
        assert_eq!(ok["LYRASHIELD_LLM"], "azure/gpt-6-sol");
    }

    #[test]
    fn legacy_azure_record_without_deployment_deserializes_but_fails_gate() {
        let creds: AzureCredentials =
            serde_json::from_str(r#"{"api_key":"k","endpoint":"https://my.openai.azure.com"}"#)
                .unwrap();
        assert!(creds.deployment.is_empty());
        assert!(
            validate_azure_credentials(&creds.api_key, &creds.endpoint, &creds.deployment).is_err()
        );
    }

    #[test]
    fn stored_provider_selection_round_trips_tokens() {
        assert_eq!(
            ByokProvider::from_stored("chatgpt"),
            Some(ByokProvider::ChatGpt)
        );
        assert_eq!(
            ByokProvider::from_stored("azure"),
            Some(ByokProvider::Azure)
        );
        assert_eq!(ByokProvider::from_stored("openai"), None);
        assert_eq!(ByokProvider::from_stored(""), None);
        assert_eq!(ByokProvider::ChatGpt.as_str(), "chatgpt");
        assert_eq!(ByokProvider::Azure.as_str(), "azure");
    }
}
