use crate::license::{is_build_installable, types::StoredLicense};
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

/// The bundled license signing public key.
const BUNDLED_PUBLIC_KEY: &str = include_str!("../../resources/license-signing-public-key.pem");

/// Result of checking for updates.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum UpdateCheckResult {
    Available {
        version: String,
        current_version: String,
        notes: Option<String>,
    },
    NotAvailable {
        current_version: String,
    },
    LicenseExpired {
        current_version: String,
        perpetual_fallback_build: Option<String>,
    },
    NoLicense,
    Error {
        message: String,
    },
}

#[derive(Debug, Clone)]
struct RemoteUpdate {
    version: String,
    notes: Option<String>,
}

fn classify_update(
    stored: &StoredLicense,
    current_version: &str,
    remote: Option<RemoteUpdate>,
) -> UpdateCheckResult {
    let Some(remote) = remote else {
        return UpdateCheckResult::NotAvailable {
            current_version: current_version.to_string(),
        };
    };
    if !is_build_installable(&stored.license, &remote.version) {
        return UpdateCheckResult::LicenseExpired {
            current_version: current_version.to_string(),
            perpetual_fallback_build: stored.license.perpetual_fallback_build.clone(),
        };
    }
    UpdateCheckResult::Available {
        version: remote.version,
        current_version: current_version.to_string(),
        notes: remote.notes,
    }
}

fn validate_expected_version(expected: &str, observed: &str) -> Result<(), String> {
    if expected != observed {
        return Err("available update changed; check again".into());
    }
    Ok(())
}

fn retryable_check_error() -> UpdateCheckResult {
    UpdateCheckResult::Error {
        message: "Unable to check for updates. Try again later.".into(),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    finished: bool,
}

pub async fn check_for_update(app: &tauri::AppHandle) -> UpdateCheckResult {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let operational =
        match crate::license::ensure_license_operational(None, BUNDLED_PUBLIC_KEY).await {
            Ok(operational) => operational.stored,
            Err(crate::license::LicenseOperationalError::NoStoredLicense) => {
                return UpdateCheckResult::NoLicense;
            }
            Err(_) => {
                return UpdateCheckResult::Error {
                    message: "Unable to verify the license. Connect to the internet and try again."
                        .into(),
                }
            }
        };
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(_) => {
            return UpdateCheckResult::Error {
                message: "Updater is unavailable in this build.".into(),
            }
        }
    };
    match updater.check().await {
        Ok(update) => classify_update(
            &operational,
            &current_version,
            update.map(|update| RemoteUpdate {
                version: update.version,
                notes: update.body,
            }),
        ),
        Err(_) => retryable_check_error(),
    }
}

pub async fn install_update(app: tauri::AppHandle, expected_version: String) -> Result<(), String> {
    let operational = crate::license::ensure_license_operational(None, BUNDLED_PUBLIC_KEY)
        .await
        .map_err(|_| {
            "Unable to verify the license. Connect to the internet and try again.".to_string()
        })?;
    let update = app
        .updater()
        .map_err(|_| "Updater is unavailable in this build.".to_string())?
        .check()
        .await
        .map_err(|_| "Unable to check for updates. Try again later.".to_string())?
        .ok_or_else(|| "No update is available.".to_string())?;
    validate_expected_version(&expected_version, &update.version)?;
    if !is_build_installable(&operational.stored.license, &update.version) {
        return Err("This license is not eligible for that update.".into());
    }

    let progress_app = app.clone();
    let finished_app = app.clone();
    let downloaded_bytes = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let progress_bytes = downloaded_bytes.clone();
    let finished_bytes = downloaded_bytes.clone();
    update
        .download_and_install(
            move |chunk_bytes, total_bytes| {
                let downloaded_bytes = progress_bytes
                    .fetch_add(chunk_bytes as u64, std::sync::atomic::Ordering::Relaxed)
                    .saturating_add(chunk_bytes as u64);
                let _ = progress_app.emit(
                    "updater://progress",
                    UpdateProgress {
                        downloaded_bytes,
                        total_bytes,
                        finished: false,
                    },
                );
            },
            move || {
                let downloaded_bytes = finished_bytes.load(std::sync::atomic::Ordering::Relaxed);
                let _ = finished_app.emit(
                    "updater://progress",
                    UpdateProgress {
                        downloaded_bytes,
                        total_bytes: Some(downloaded_bytes),
                        finished: true,
                    },
                );
            },
        )
        .await
        .map_err(|_| "Update download or signature verification failed.".to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::license::types::{LicenseFile, LicenseSku, StoredLicense};

    fn expired_license() -> StoredLicense {
        StoredLicense {
            version: 2,
            license_id: "lic_test".into(),
            license: LicenseFile {
                sku: LicenseSku::IndividualLaunch,
                seat_count: 1,
                machine_ids: vec!["machine".into()],
                update_eligible_until: "2020-01-01T00:00:00Z".into(),
                perpetual_fallback_build: Some("1.2.0".into()),
                signing_key_id: "test".into(),
                signature: "test".into(),
                issued_at: "2020-01-01T00:00:00Z".into(),
            },
            blob: "blob".into(),
            last_server_verified_at: Some(chrono::Utc::now().to_rfc3339()),
        }
    }

    #[test]
    fn available_update_within_perpetual_fallback_is_installable() {
        let result = classify_update(
            &expired_license(),
            "1.1.0",
            Some(RemoteUpdate {
                version: "1.2.0".into(),
                notes: Some("Maintenance release".into()),
            }),
        );
        assert!(
            matches!(result, UpdateCheckResult::Available { version, .. } if version == "1.2.0")
        );
    }

    #[test]
    fn update_beyond_perpetual_fallback_is_refused() {
        let result = classify_update(
            &expired_license(),
            "1.1.0",
            Some(RemoteUpdate {
                version: "1.3.0".into(),
                notes: None,
            }),
        );
        assert!(matches!(result, UpdateCheckResult::LicenseExpired { .. }));
    }

    #[test]
    fn no_remote_update_returns_not_available() {
        let result = classify_update(&expired_license(), "1.1.0", None);
        assert!(matches!(result, UpdateCheckResult::NotAvailable { .. }));
    }

    #[test]
    fn install_recheck_rejects_version_substitution() {
        let error = validate_expected_version("1.2.0", "1.2.1").unwrap_err();
        assert_eq!(error, "available update changed; check again");
    }

    #[test]
    fn network_error_is_safe_and_retryable() {
        let result = retryable_check_error();
        assert!(matches!(
            result,
            UpdateCheckResult::Error { message }
                if message == "Unable to check for updates. Try again later."
        ));
    }

    #[test]
    fn update_result_fields_match_frontend_camel_case_contract() {
        let value = serde_json::to_value(UpdateCheckResult::Available {
            version: "0.1.1".into(),
            current_version: "0.1.1-rc.1".into(),
            notes: None,
        })
        .unwrap();
        assert_eq!(value["state"], "available");
        assert_eq!(value["currentVersion"], "0.1.1-rc.1");
    }
}
