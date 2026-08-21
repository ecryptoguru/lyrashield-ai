use crate::license::{is_build_installable, store, types::StoredLicense, verify_license};

/// The bundled license signing public key.
const BUNDLED_PUBLIC_KEY: &str = include_str!("../../resources/license-signing-public-key.pem");

/// Result of checking for updates.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
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

/// Check whether the user is allowed to install an update based on their license.
///
/// - No license → refuse updates.
/// - License valid + update-eligible → allow.
/// - License valid but eligibility expired → refuse newer builds, allow
///   builds <= perpetualFallbackBuild.
/// - License revoked → refuse.
///
/// Gated by single guard — caller must have validated operational license before.
pub fn check_update_eligibility() -> UpdateCheckResult {
    let current_version = env!("CARGO_PKG_VERSION").to_string();

    let stored = match store::load_license() {
        Ok(Some(s)) => s,
        Ok(None) => return UpdateCheckResult::NoLicense,
        Err(e) => return UpdateCheckResult::Error { message: e },
    };

    // Verify the license is still valid.
    let verification = verify_license(&stored.license, BUNDLED_PUBLIC_KEY);
    if !verification.valid {
        return UpdateCheckResult::NoLicense;
    }

    // Machine binding already checked by guard, but double-check here for direct calls.
    let machine_id = crate::machine_id::generate_machine_id();
    if !stored.license.machine_ids.contains(&machine_id) {
        return UpdateCheckResult::NoLicense;
    }

    if verification.update_eligible {
        UpdateCheckResult::NotAvailable { current_version }
    } else {
        UpdateCheckResult::LicenseExpired {
            current_version,
            perpetual_fallback_build: stored.license.perpetual_fallback_build.clone(),
        }
    }
}

/// Gated variant — caller passes the result of ensure_license_operational. All failures non-operational.
pub fn check_update_eligibility_with_guard(
    guard: Result<StoredLicense, String>,
) -> UpdateCheckResult {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    match guard {
        Ok(stored) => {
            let verification = verify_license(&stored.license, BUNDLED_PUBLIC_KEY);
            if !verification.valid {
                return UpdateCheckResult::NoLicense;
            }
            if verification.update_eligible {
                UpdateCheckResult::NotAvailable { current_version }
            } else {
                UpdateCheckResult::LicenseExpired {
                    current_version,
                    perpetual_fallback_build: stored.license.perpetual_fallback_build.clone(),
                }
            }
        }
        Err(e) => UpdateCheckResult::Error { message: e },
    }
}

/// Check if a specific target version is installable under the current license.
/// Gated — requires operational license and eligibility.
pub fn is_version_installable(target_version: &str) -> bool {
    let stored = match store::load_license() {
        Ok(Some(s)) => s,
        _ => return false,
    };

    let verification = verify_license(&stored.license, BUNDLED_PUBLIC_KEY);
    if !verification.valid {
        return false;
    }
    let machine_id = crate::machine_id::generate_machine_id();
    if !stored.license.machine_ids.contains(&machine_id) {
        return false;
    }
    if !verification.update_eligible && !is_build_installable(&stored.license, target_version) {
        return false;
    }
    // If still eligible, any build allowed; if expired, only fallback allowed (handled by is_build_installable)
    if verification.update_eligible {
        return true;
    }
    is_build_installable(&stored.license, target_version)
}

/// Gate install path — must be called before any updater install. Returns Ok if allowed.
pub fn ensure_install_allowed(target_version: &str) -> Result<(), String> {
    if !is_version_installable(target_version) {
        return Err(format!(
            "install not allowed for version {}",
            target_version
        ));
    }
    Ok(())
}
