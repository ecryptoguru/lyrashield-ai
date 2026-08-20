use crate::license::{is_build_installable, store, verify_license};

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
pub fn check_update_eligibility() -> UpdateCheckResult {
    let current_version = env!("CARGO_PKG_VERSION").to_string();

    let license_file = match store::load_license() {
        Ok(Some(file)) => file,
        Ok(None) => return UpdateCheckResult::NoLicense,
        Err(e) => return UpdateCheckResult::Error { message: e },
    };

    // Verify the license is still valid.
    let verification = verify_license(&license_file, BUNDLED_PUBLIC_KEY);
    if !verification.valid {
        return UpdateCheckResult::NoLicense;
    }

    // Check if the target build is installable.
    // The Tauri updater plugin handles the actual download + signature verification.
    // We only gate on license eligibility here.
    if verification.update_eligible {
        // The updater plugin will check for available updates.
        // We return NotAvailable here; the frontend calls the Tauri updater API
        // to get the actual available version.
        UpdateCheckResult::NotAvailable { current_version }
    } else {
        UpdateCheckResult::LicenseExpired {
            current_version,
            perpetual_fallback_build: license_file.perpetual_fallback_build,
        }
    }
}

/// Check if a specific target version is installable under the current license.
pub fn is_version_installable(target_version: &str) -> bool {
    let license_file = match store::load_license() {
        Ok(Some(file)) => file,
        _ => return false,
    };

    let verification = verify_license(&license_file, BUNDLED_PUBLIC_KEY);
    if !verification.valid {
        return false;
    }

    is_build_installable(&license_file, target_version)
}
