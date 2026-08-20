use crate::license::types::LicenseFile;
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
/// permissions (0o600 on Unix).
pub fn save_license(file: &LicenseFile) -> Result<(), String> {
    let path = license_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create license dir: {}", e))?;
    }

    let json = serde_json::to_string_pretty(file)
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

/// Load the stored license file, if any.
pub fn load_license() -> Result<Option<LicenseFile>, String> {
    let path = license_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("failed to read license file: {}", e))?;
    let file: LicenseFile =
        serde_json::from_str(&contents).map_err(|e| format!("failed to parse license: {}", e))?;
    Ok(Some(file))
}

/// Clear the stored license file (on revoke hard-stop or user-initiated logout).
pub fn clear_license() -> Result<(), String> {
    let path = license_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("failed to remove license: {}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::license::types::{LicenseFile, LicenseSku};
    use std::sync::{Mutex, OnceLock};

    // Serialize all store tests — they share the global HOME/XDG_DATA_HOME env.
    static STORE_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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
        let _lock = STORE_TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();

        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());

        let license = test_license();
        save_license(&license).unwrap();
        let loaded = load_license().unwrap();
        assert!(loaded.is_some());
        let loaded = loaded.unwrap();
        assert_eq!(loaded.sku, LicenseSku::IndividualLaunch);
        assert_eq!(loaded.seat_count, 1);
        assert_eq!(loaded.machine_ids, vec!["test-machine".to_string()]);
    }

    #[test]
    fn test_clear_license() {
        let _lock = STORE_TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();

        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());

        let license = test_license();
        save_license(&license).unwrap();
        assert!(load_license().unwrap().is_some());
        clear_license().unwrap();
        assert!(load_license().unwrap().is_none());
    }
}
