use crate::api::ApiClient;
use crate::byok::{self, ChatGptAuthStatus};
use crate::license::{store, types::*, verify_license};
use crate::machine_id::generate_machine_id;
use crate::runtime::{self, RuntimeStatus};
use crate::scan::types::*;
use crate::scan::{self};
use crate::sync::{self, SyncConnection, SyncResult};
use crate::updater;

/// The bundled license signing public key (production ed25519).
const BUNDLED_PUBLIC_KEY: &str = include_str!("../resources/license-signing-public-key.pem");

// --- License commands ---

#[tauri::command]
pub async fn activate_license(
    license_key: String,
    api_url: Option<String>,
) -> Result<LicenseStatus, String> {
    let machine_id = generate_machine_id();
    let client = ApiClient::new(api_url.clone())?;
    let response = client.activate(&license_key, &machine_id).await?;
    let verification = verify_license(&response.license, BUNDLED_PUBLIC_KEY);
    if !verification.valid {
        return Err(format!(
            "Server returned a license that failed local verification: {:?}",
            verification.reason
        ));
    }
    // Machine must be bound in the issued license.
    if !response.license.machine_ids.contains(&machine_id) {
        return Err(format!(
            "activated license does not contain this machine: {} not in {:?}",
            machine_id, response.license.machine_ids
        ));
    }
    store::save_license(&response.license, &response.license_id, &response.blob)?;
    // Store raw key in OS keychain for sync (never in React/localStorage)
    let _ = store::save_license_key(&license_key);
    Ok(license_status_from_file(&response.license))
}

#[tauri::command]
pub async fn verify_stored_license(api_url: Option<String>) -> Result<LicenseStatus, String> {
    // Rust-initiated identified revalidation gating operational state; all failures non-operational.
    let stored = store::load_license()?.ok_or_else(|| "no stored license".to_string())?;
    if stored.license_id.is_empty() {
        store::clear_license()?;
        return Ok(LicenseStatus::Revoked);
    }
    let result = verify_license(&stored.license, BUNDLED_PUBLIC_KEY);
    if !result.valid {
        store::clear_license()?;
        return Ok(LicenseStatus::Revoked);
    }
    // Machine binding check.
    let machine_id = generate_machine_id();
    if !stored.license.machine_ids.contains(&machine_id) {
        store::clear_license()?;
        return Ok(LicenseStatus::Revoked);
    }

    // Identified server revocation check — must send licenseId. All transport/parse failures are non-operational.
    let client = ApiClient::new(api_url).map_err(|e| format!("revalidation failed: {}", e))?;
    let server_response = client
        .verify(&stored.license, &stored.license_id)
        .await
        .map_err(|e| format!("revalidation failed: {}", e))?;
    if server_response.revoked || !server_response.valid {
        store::clear_license()?;
        return Ok(LicenseStatus::Revoked);
    }
    // Eligibility — expired is non-operational per guard (single guard includes eligibility).
    if !result.update_eligible {
        // Do not clear file, but mark expired eligibility as non-operational for scan/updater gate.
        // For startup, treat as Revoked/Expired per status helper.
        return Ok(license_status_from_file(&stored.license));
    }
    Ok(license_status_from_file(&stored.license))
}

#[tauri::command]
pub fn get_license_status() -> Result<LicenseStatus, String> {
    let stored = store::load_license()?;
    match stored {
        Some(s) => {
            let result = verify_license(&s.license, BUNDLED_PUBLIC_KEY);
            if !result.valid {
                return Ok(LicenseStatus::Revoked);
            }
            // Machine binding check for status as well.
            let machine_id = generate_machine_id();
            if !s.license.machine_ids.contains(&machine_id) {
                return Ok(LicenseStatus::Revoked);
            }
            Ok(license_status_from_file(&s.license))
        }
        None => Ok(LicenseStatus::None),
    }
}

#[tauri::command]
pub async fn startup_revalidate_license(api_url: Option<String>) -> Result<LicenseStatus, String> {
    // Explicit Rust-initiated startup revalidation — all failures non-operational.
    verify_stored_license(api_url).await
}

#[tauri::command]
pub fn clear_license() -> Result<(), String> {
    store::clear_license()
}

// --- Runtime commands ---

#[tauri::command]
pub fn get_runtime_status() -> Result<RuntimeStatus, String> {
    Ok(runtime::get_runtime_status())
}

// --- BYOK commands ---

#[tauri::command]
pub fn start_chatgpt_login() -> Result<(), String> {
    byok::login_chatgpt()
}

#[tauri::command]
pub fn check_chatgpt_status() -> Result<ChatGptAuthStatus, String> {
    Ok(byok::check_chatgpt_auth())
}

#[tauri::command]
pub fn logout_chatgpt() -> Result<(), String> {
    byok::logout_chatgpt()
}

#[tauri::command]
pub fn save_azure_config(api_key: String, endpoint: String) -> Result<(), String> {
    byok::save_azure_credentials(&api_key, &endpoint)
}

#[tauri::command]
pub fn load_azure_config() -> Result<Option<byok::AzureCredentials>, String> {
    byok::load_azure_credentials()
}

#[tauri::command]
pub fn clear_azure_config() -> Result<(), String> {
    byok::clear_azure_credentials()
}

#[tauri::command]
pub fn get_byok_metadata() -> Result<byok::AzureMetadata, String> {
    byok::get_azure_metadata()
}

#[tauri::command]
pub fn get_byok_status() -> Result<byok::ByokStatus, String> {
    byok::get_byok_status()
}

// --- Scan commands ---

#[tauri::command]
pub async fn start_scan(
    app: tauri::AppHandle,
    target: ScanTarget,
    mode: ScanMode,
    instruction: Option<String>,
) -> Result<String, String> {
    // Single guard pre scan side effects validating signature, machine membership, status, revocation, eligibility.
    // Must be before any subprocess spawn.
    crate::license::ensure_license_operational(None, BUNDLED_PUBLIC_KEY)
        .await
        .map_err(|e| format!("license not operational: {}", e))?;

    let scan_id = format!("scan-{}", chrono::Utc::now().timestamp_millis());
    let config = ScanConfig {
        scan_id: scan_id.clone(),
        target,
        mode,
        instruction,
    };
    scan::start_scan(app, config).await
}

#[tauri::command]
pub async fn cancel_scan(app: tauri::AppHandle, scan_id: String) -> Result<(), String> {
    crate::scan::runner::cancel_scan(app, scan_id).await
}

#[tauri::command]
pub async fn list_scans(app: tauri::AppHandle) -> Result<Vec<ScanSummary>, String> {
    crate::scan::store::list_scans(&app).await
}

#[tauri::command]
pub async fn get_scan_detail(app: tauri::AppHandle, scan_id: String) -> Result<ScanDetail, String> {
    crate::scan::store::get_scan_detail(&app, &scan_id).await
}

#[tauri::command]
pub async fn get_scan_events(
    app: tauri::AppHandle,
    scan_id: String,
    from_seq: Option<u64>,
) -> Result<Vec<SequencedEvent>, String> {
    crate::scan::store::get_events(&app, &scan_id, from_seq.unwrap_or(0)).await
}

#[tauri::command]
pub fn export_sarif(findings: Vec<Finding>, scan_id: String) -> Result<String, String> {
    crate::scan::store::export_sarif(&findings, &scan_id)
}

// --- Updater commands ---

#[tauri::command]
pub async fn check_update_eligibility(
    api_url: Option<String>,
) -> Result<updater::UpdateCheckResult, String> {
    // Guard before updater side effects.
    let guard = crate::license::ensure_license_operational(api_url, BUNDLED_PUBLIC_KEY).await;
    Ok(updater::check_update_eligibility_with_guard(guard))
}

// --- Sync commands ---

#[tauri::command]
pub async fn connect_workspace(
    api_url: Option<String>,
    workspace_id: String,
) -> Result<SyncConnection, String> {
    sync::connect_workspace(api_url, &workspace_id).await
}

#[tauri::command]
pub fn save_sync_api_key(api_key: String) -> Result<(), String> {
    sync::save_sync_api_key(&api_key)
}

#[tauri::command]
pub fn has_sync_api_key() -> Result<bool, String> {
    sync::has_sync_api_key()
}

#[tauri::command]
pub async fn sync_findings(
    api_url: Option<String>,
    workspace_id: String,
    findings: Vec<Finding>,
) -> Result<Vec<SyncResult>, String> {
    Ok(sync::sync_findings(api_url, &workspace_id, &findings).await)
}

#[tauri::command]
pub async fn get_sync_state() -> Result<Option<SyncConnection>, String> {
    sync::get_sync_state().await
}

#[tauri::command]
pub async fn fetch_sync_cursor(
    api_url: Option<String>,
    workspace_id: String,
) -> Result<SyncConnection, String> {
    sync::fetch_and_adopt_cursor(api_url, &workspace_id).await
}

#[tauri::command]
pub fn disconnect_sync() -> Result<(), String> {
    sync::disconnect()?;
    sync::clear_sync_api_key()
}

// --- Helpers ---

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
