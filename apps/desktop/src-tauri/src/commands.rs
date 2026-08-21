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
    let client = ApiClient::new(api_url)?;
    let response = client.activate(&license_key, &machine_id).await?;
    let verification = verify_license(&response.license, BUNDLED_PUBLIC_KEY);
    if !verification.valid {
        return Err(format!(
            "Server returned a license that failed local verification: {:?}",
            verification.reason
        ));
    }
    store::save_license(&response.license)?;
    Ok(license_status_from_file(&response.license))
}

#[tauri::command]
pub async fn verify_stored_license(api_url: Option<String>) -> Result<LicenseStatus, String> {
    let license_file = store::load_license()?.ok_or_else(|| "no stored license".to_string())?;
    let result = verify_license(&license_file, BUNDLED_PUBLIC_KEY);
    if !result.valid {
        store::clear_license()?;
        return Ok(LicenseStatus::Revoked);
    }
    if let Ok(client) = ApiClient::new(api_url) {
        if let Ok(server_response) = client.verify(&license_file).await {
            if server_response.revoked {
                store::clear_license()?;
                return Ok(LicenseStatus::Revoked);
            }
        }
    }
    Ok(license_status_from_file(&license_file))
}

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
pub async fn create_scan(
    app: tauri::AppHandle,
    target: ScanTarget,
    mode: ScanMode,
    instruction: Option<String>,
) -> Result<String, String> {
    let scan_id = format!("scan-{}", chrono::Utc::now().timestamp_millis());
    let config = ScanConfig {
        scan_id: scan_id.clone(),
        target,
        mode,
        instruction,
    };
    crate::scan::runner::create_scan_record(app, &config).await?;
    Ok(scan_id)
}

#[tauri::command]
pub async fn start_scan(
    app: tauri::AppHandle,
    target: ScanTarget,
    mode: ScanMode,
    instruction: Option<String>,
) -> Result<String, String> {
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
pub fn check_update_eligibility() -> Result<updater::UpdateCheckResult, String> {
    Ok(updater::check_update_eligibility())
}

// --- Sync commands ---

#[tauri::command]
pub async fn connect_workspace(
    api_url: Option<String>,
    workspace_id: String,
    license_key: String,
) -> Result<SyncConnection, String> {
    sync::connect_workspace(api_url, &workspace_id, &license_key).await
}

#[tauri::command]
pub async fn sync_findings(
    api_url: Option<String>,
    connection: SyncConnection,
    findings: Vec<Finding>,
) -> Result<Vec<SyncResult>, String> {
    Ok(sync::sync_findings(api_url, &connection, &findings).await)
}

#[tauri::command]
pub fn disconnect_sync() -> Result<(), String> {
    sync::disconnect()
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
