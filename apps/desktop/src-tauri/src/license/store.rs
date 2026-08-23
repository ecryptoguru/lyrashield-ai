use crate::license::types::{LicenseFile, StoredLicense};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

/// Returns the path to the local license file in the OS app data directory.
///
/// macOS: `~/Library/Application Support/LyraShield/license.json`
/// Windows: `%APPDATA%/LyraShield/license.json`
/// Linux: `~/.local/share/LyraShield/license.json`
fn license_path() -> Result<PathBuf, String> {
    let dir = dirs::data_dir().ok_or_else(|| "could not determine app data dir".to_string())?;
    let app_dir = dir.join("LyraShield");
    Ok(app_dir.join("license.json"))
}

/// Save a license file to the local app data directory with restrictive
/// permissions (0o600 on Unix). Persists versioned envelope with immutable licenseId.
pub fn save_license(file: &LicenseFile, license_id: &str, blob: &str) -> Result<(), String> {
    let stored = StoredLicense {
        version: 2,
        license_id: license_id.to_string(),
        license: file.clone(),
        blob: blob.to_string(),
        last_server_verified_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    save_stored(&stored)
}

pub(super) fn save_stored(stored: &StoredLicense) -> Result<(), String> {
    let path = license_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create license dir: {}", e))?;
    }

    let json = serde_json::to_string_pretty(stored)
        .map_err(|e| format!("failed to serialize license: {}", e))?;

    // Write atomically via a temp file + rename.
    let tmp = path.with_extension("json.tmp");
    let mut f =
        fs::File::create(&tmp).map_err(|e| format!("failed to create temp license file: {}", e))?;
    f.write_all(json.as_bytes())
        .map_err(|e| format!("failed to write license: {}", e))?;
    f.sync_all()
        .map_err(|e| format!("failed to sync license: {}", e))?;

    // Set restrictive permissions on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("failed to set license permissions: {}", e))?;
    }

    fs::rename(&tmp, &path).map_err(|e| format!("failed to move license into place: {}", e))?;
    Ok(())
}

/// Load the stored license file, if any. Handles both v1 StoredLicense and legacy plain LicenseFile for migration.
pub fn load_license() -> Result<Option<StoredLicense>, String> {
    let path = license_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("failed to read license file: {}", e))?;
    // Try v1 envelope first.
    if let Ok(stored) = serde_json::from_str::<StoredLicense>(&contents) {
        if matches!(stored.version, 1 | 2) && !stored.license_id.is_empty() {
            return Ok(Some(stored));
        }
    }
    // Fallback: legacy plain LicenseFile — treat as non-identified (no licenseId) but still load for migration.
    if let Ok(file) = serde_json::from_str::<LicenseFile>(&contents) {
        return Ok(Some(StoredLicense {
            version: 1,
            license_id: String::new(),
            license: file,
            blob: String::new(),
            last_server_verified_at: None,
        }));
    }
    Err("failed to parse license: unknown format".into())
}

/// Load only the LicenseFile (legacy helper for simple checks).
pub fn load_license_file() -> Result<Option<LicenseFile>, String> {
    Ok(load_license()?.map(|s| s.license))
}

/// Clear the stored license file (on revoke hard-stop or user-initiated logout).
pub fn clear_license() -> Result<(), String> {
    let path = license_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("failed to remove license: {}", e))?;
    }
    // Also clear keychain raw key
    let _ = clear_license_key();
    Ok(())
}

// ── Raw license key in OS keychain (never in React/localStorage) ──
const KEYCHAIN_SERVICE: &str = "lyrashield";
const LICENSE_KEY_ACCOUNT: &str = "license-key";

pub fn save_license_key(key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, LICENSE_KEY_ACCOUNT)
        .map_err(|e| format!("keychain entry: {}", e))?;
    entry
        .set_password(key)
        .map_err(|e| format!("save license key to keychain: {}", e))
}

pub fn load_license_key() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, LICENSE_KEY_ACCOUNT)
        .map_err(|e| format!("keychain entry: {}", e))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("read license key from keychain: {}", e)),
    }
}

pub fn clear_license_key() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, LICENSE_KEY_ACCOUNT)
        .map_err(|e| format!("keychain entry: {}", e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("clear license key: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::license::types::{LicenseFile, LicenseSku};
    use std::sync::{Mutex, OnceLock};

    // Serialize all store tests — they share the global HOME/XDG_DATA_HOME env.
    static STORE_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    // Shared with guard tests to avoid HOME race — guard tests use crate::license::TEST_ENV_LOCK which is same underlying OnceLock

    fn test_license() -> LicenseFile {
        LicenseFile {
            sku: LicenseSku::IndividualLaunch,
            seat_count: 1,
            machine_ids: vec!["test-machine".into()],
            update_eligible_until: "2036-01-01T00:00:00.000Z".into(),
            perpetual_fallback_build: Some("1.2.0".into()),
            signing_key_id: "test-key".into(),
            signature: "test-sig".into(),
            issued_at: "2026-08-20T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn test_save_and_load_license() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();

        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());

        let license = test_license();
        save_license(&license, "lic_test_123", "blob123").unwrap();
        let loaded = load_license().unwrap();
        assert!(loaded.is_some());
        let loaded = loaded.unwrap();
        assert_eq!(loaded.license.sku, LicenseSku::IndividualLaunch);
        assert_eq!(loaded.license.seat_count, 1);
        assert_eq!(loaded.license.machine_ids, vec!["test-machine".to_string()]);
        assert_eq!(loaded.license_id, "lic_test_123");
        assert_eq!(loaded.version, 2);
        assert_eq!(loaded.blob, "blob123");
        let persisted = std::fs::read_to_string(license_path().unwrap()).unwrap();
        let json: serde_json::Value = serde_json::from_str(&persisted).unwrap();
        assert!(json["lastServerVerifiedAt"].as_str().is_some());
    }

    #[test]
    fn test_clear_license() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();

        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());

        let license = test_license();
        save_license(&license, "lic_test_123", "blob").unwrap();
        assert!(load_license().unwrap().is_some());
        clear_license().unwrap();
        assert!(load_license().unwrap().is_none());
    }

    #[test]
    fn test_legacy_plain_file_migrates() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();

        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());

        // Write legacy plain LicenseFile JSON directly.
        let license = test_license();
        let path = license_path().unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = serde_json::to_string_pretty(&license).unwrap();
        std::fs::write(&path, json).unwrap();

        let loaded = load_license().unwrap().unwrap();
        // Legacy migrates to stored with empty license_id (triggers re-activation requirement)
        assert_eq!(loaded.license.seat_count, 1);
        assert_eq!(loaded.license_id, "");
    }
}
