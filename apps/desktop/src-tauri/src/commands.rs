use crate::api::ApiClient;
use crate::byok::{self, ChatGptAuthStatus};
use crate::license::{store, types::*, verify_license};
use crate::machine_id::generate_machine_id;
use crate::runtime::{self, RuntimeStatus};

/// The bundled license signing public key (production ed25519).
///
/// This is the **public** key — safe to bundle. The private key lives only in
/// Azure Key Vault. The desktop never accepts a server-supplied public key.
const BUNDLED_PUBLIC_KEY: &str = include_str!("../resources/license-signing-public-key.pem");

/// Activate a license key on this machine.
///
/// Calls `POST /api/licenses/activate`, stores the returned license file,
/// verifies the signature locally against the bundled public key, and returns
/// the activation result.
#[tauri::command]
pub async fn activate_license(
    license_key: String,
    api_url: Option<String>,
) -> Result<LicenseStatus, String> {
    let machine_id = generate_machine_id();
    let client = ApiClient::new(api_url)?;

    let response = client.activate(&license_key, &machine_id).await?;

    // Verify the returned license against the bundled public key.
    let verification = verify_license(&response.license, BUNDLED_PUBLIC_KEY);
    if !verification.valid {
        return Err(format!(
            "Server returned a license that failed local verification: {:?}",
            verification.reason
        ));
    }

    // Store the license locally.
    store::save_license(&response.license)?;

    Ok(license_status_from_file(&response.license))
}

/// Verify the stored license locally (offline grace) and optionally check
/// revocation with the server if online.
#[tauri::command]
pub async fn verify_stored_license(api_url: Option<String>) -> Result<LicenseStatus, String> {
    let license_file = store::load_license()?.ok_or_else(|| "no stored license".to_string())?;

    // Always verify locally first (offline grace).
    let result = verify_license(&license_file, BUNDLED_PUBLIC_KEY);
    if !result.valid {
        // Signature broken → clear and hard-stop.
        store::clear_license()?;
        return Ok(LicenseStatus::Revoked);
    }

    // If we have a server URL, check revocation.
    if let Ok(client) = ApiClient::new(api_url) {
        match client.verify(&license_file).await {
            Ok(server_response) => {
                if server_response.revoked {
                    store::clear_license()?;
                    return Ok(LicenseStatus::Revoked);
                }
            }
            Err(_) => {
                // Network error — fall through to offline grace.
            }
        }
    }

    Ok(license_status_from_file(&license_file))
}

/// Get the current license status without network calls.
#[tauri::command]
pub fn get_license_status() -> Result<LicenseStatus, String> {
    let license_file = store::load_license()?;
    match license_file {
        Some(file) => {
            let result = verify_license(&file, BUNDLED_PUBLIC_KEY);
            if !result.valid {
                return Ok(LicenseStatus::Revoked);
            }
            Ok(license_status_from_file(&file))
        }
        None => Ok(LicenseStatus::None),
    }
}

/// Clear the stored license (on revoke hard-stop or user logout).
#[tauri::command]
pub fn clear_license() -> Result<(), String> {
    store::clear_license()
}

/// Get runtime status (engine + Docker detection).
#[tauri::command]
pub fn get_runtime_status() -> Result<RuntimeStatus, String> {
    Ok(runtime::get_runtime_status())
}

/// Start ChatGPT OAuth login (spawns `lyrashield auth login chatgpt`).
#[tauri::command]
pub fn start_chatgpt_login() -> Result<(), String> {
    byok::login_chatgpt()
}

/// Check ChatGPT auth status.
#[tauri::command]
pub fn check_chatgpt_status() -> Result<ChatGptAuthStatus, String> {
    Ok(byok::check_chatgpt_auth())
}

/// Log out of ChatGPT.
#[tauri::command]
pub fn logout_chatgpt() -> Result<(), String> {
    byok::logout_chatgpt()
}

/// Save Azure OpenAI credentials to the OS keychain.
#[tauri::command]
pub fn save_azure_config(api_key: String, endpoint: String) -> Result<(), String> {
    byok::save_azure_credentials(&api_key, &endpoint)
}

/// Load Azure OpenAI credentials from the OS keychain.
#[tauri::command]
pub fn load_azure_config() -> Result<Option<byok::AzureCredentials>, String> {
    byok::load_azure_credentials()
}

/// Clear Azure OpenAI credentials from the OS keychain.
#[tauri::command]
pub fn clear_azure_config() -> Result<(), String> {
    byok::clear_azure_credentials()
}

/// Derive a LicenseStatus from a verified LicenseFile.
fn license_status_from_file(file: &LicenseFile) -> LicenseStatus {
    let eligible_until = chrono::DateTime::parse_from_rfc3339(&file.update_eligible_until).ok();
    let now = chrono::Utc::now();
    let update_eligible = eligible_until
        .map(|dt| dt.with_timezone(&chrono::Utc) > now)
        .unwrap_or(false);

    if update_eligible {
        LicenseStatus::Active {
            sku: file.sku.clone(),
            seat_count: file.seat_count,
            machine_count: file.machine_ids.len(),
            update_eligible_until: file.update_eligible_until.clone(),
            update_eligible: true,
            perpetual_fallback_build: file.perpetual_fallback_build.clone(),
        }
    } else {
        LicenseStatus::ExpiredEligibility {
            update_eligible_until: file.update_eligible_until.clone(),
            perpetual_fallback_build: file.perpetual_fallback_build.clone(),
        }
    }
}
