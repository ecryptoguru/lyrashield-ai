use crate::license::canonical_json;
use crate::license::types::{LicenseFile, StoredLicense};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

// ── StoredLicense integrity (VULN-F-001) ────────────────────────────────────
// license.json is user-writable, so its fields — in particular the offline
// grace anchor `lastServerVerifiedAt` — need a local authenticity check that
// a file editor cannot reproduce. We HMAC-SHA256 the canonical row over a key
// derived from the keychain-held license key:
//   integrity_key = SHA-256("lyrashield/license-integrity-v1" || license_key)
// The license key is high-entropy, per-license, and lives only in the OS
// keychain — it never touches disk, so a tampered timestamp fails the MAC and
// the grace anchor is untrusted (load_license nulls it → offline grace denied
// → forced online re-verification, which reveals revocation).
const INTEGRITY_DOMAIN: &[u8] = b"lyrashield/license-integrity-v1\x00";

/// RFC 2104 HMAC-SHA256 (no `hmac` crate in the dependency set — sha2 only).
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block_key = [0u8; BLOCK];
    if key.len() > BLOCK {
        block_key[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block_key[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= block_key[i];
        opad[i] ^= block_key[i];
    }
    let mut inner_input = Vec::with_capacity(BLOCK + message.len());
    inner_input.extend_from_slice(&ipad);
    inner_input.extend_from_slice(message);
    let inner = Sha256::digest(&inner_input);
    let mut outer_input = Vec::with_capacity(BLOCK + inner.len());
    outer_input.extend_from_slice(&opad);
    outer_input.extend_from_slice(&inner);
    Sha256::digest(&outer_input).into()
}

fn license_integrity_key() -> Option<Vec<u8>> {
    #[cfg(test)]
    if let Some(key) = test_integrity_key() {
        return Some(key);
    }
    let license_key = load_license_key().ok()??;
    let mut hasher = Sha256::new();
    hasher.update(INTEGRITY_DOMAIN);
    hasher.update(license_key.as_bytes());
    Some(hasher.finalize().to_vec())
}

/// HMAC tag for a StoredLicense over every field except `integrity` itself.
fn stored_integrity_tag(stored: &StoredLicense, key: &[u8]) -> String {
    let mut value = match serde_json::to_value(stored) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    if let Some(obj) = value.as_object_mut() {
        obj.remove("integrity");
    }
    let canonical = canonical_json(&value);
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(hmac_sha256(key, canonical.as_bytes()))
}

/// Constant-time tag comparison — both values are base64 MACs, so a fast
/// timing oracle is implausible, but compare on decoded bytes anyway.
fn tags_equal(a: &str, b: &str) -> bool {
    use base64::Engine;
    let (Ok(x), Ok(y)) = (
        base64::engine::general_purpose::STANDARD.decode(a),
        base64::engine::general_purpose::STANDARD.decode(b),
    ) else {
        return false;
    };
    if x.len() != y.len() {
        return false;
    }
    x.iter()
        .zip(y.iter())
        .fold(0u8, |acc, (p, q)| acc | (p ^ q))
        == 0
}

/// Verify a loaded row's integrity tag. When the keychain-derived key is
/// unavailable (key never stored / keychain inaccessible) or the tag is
/// absent or mismatched, the offline-grace anchor is untrusted and cleared —
/// the signed license body itself is unaffected and still drives the normal
/// online verification path.
fn enforce_stored_integrity(stored: &mut StoredLicense) {
    let Some(key) = license_integrity_key() else {
        stored.last_server_verified_at = None;
        return;
    };
    let expected = stored_integrity_tag(stored, &key);
    let trusted = stored
        .integrity
        .as_deref()
        .is_some_and(|tag| tags_equal(tag, &expected));
    if !trusted {
        stored.last_server_verified_at = None;
    }
}

#[cfg(test)]
static TEST_INTEGRITY_KEY: std::sync::OnceLock<std::sync::Mutex<Option<Vec<u8>>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
fn test_integrity_key() -> Option<Vec<u8>> {
    TEST_INTEGRITY_KEY
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap()
        .clone()
}

#[cfg(test)]
pub(super) fn set_test_integrity_key(key: Option<Vec<u8>>) {
    *TEST_INTEGRITY_KEY
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap() = key;
}

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
        integrity: None,
    };
    save_stored(&stored)
}

pub(super) fn save_stored(stored: &StoredLicense) -> Result<(), String> {
    let path = license_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create license dir: {}", e))?;
    }

    // Stamp the integrity tag when the keychain-derived key is available. On
    // first activation the license key lands in the keychain before this
    // write; when it is unavailable the row persists untagged and load clears
    // the grace anchor — fail closed, never silently trusted.
    let mut stored = stored.clone();
    stored.integrity = license_integrity_key().map(|key| stored_integrity_tag(&stored, &key));

    let json = serde_json::to_string_pretty(&stored)
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
    if let Ok(mut stored) = serde_json::from_str::<StoredLicense>(&contents) {
        if matches!(stored.version, 1 | 2) && !stored.license_id.is_empty() {
            enforce_stored_integrity(&mut stored);
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
            integrity: None,
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

    // VULN-F-001: rewriting lastServerVerifiedAt in the user-writable file
    // must not extend offline grace — the row's integrity tag is HMAC'd over
    // all fields with a keychain-derived key.
    #[test]
    fn test_tampered_grace_timestamp_fails_integrity() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();

        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());
        set_test_integrity_key(Some(b"test-integrity-key".to_vec()));

        save_license(&test_license(), "lic_test_456", "blob").unwrap();
        let path = license_path().unwrap();

        // Attacker refreshes the grace anchor to "now" — the whole point of
        // the finding. Rewrite on disk and reload.
        let mut json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        json["lastServerVerifiedAt"] = serde_json::Value::String(chrono::Utc::now().to_rfc3339());
        std::fs::write(&path, serde_json::to_string_pretty(&json).unwrap()).unwrap();

        let loaded = load_license().unwrap().unwrap();
        assert!(
            loaded.last_server_verified_at.is_none(),
            "tampered grace anchor must be cleared"
        );
        set_test_integrity_key(None);
    }

    #[test]
    fn test_untampered_license_keeps_grace_anchor() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();

        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());
        set_test_integrity_key(Some(b"test-integrity-key".to_vec()));

        save_license(&test_license(), "lic_test_789", "blob").unwrap();
        let loaded = load_license().unwrap().unwrap();
        assert!(loaded.integrity.is_some());
        assert!(loaded.last_server_verified_at.is_some());
        set_test_integrity_key(None);
    }

    #[test]
    fn test_missing_integrity_key_clears_grace_anchor() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();

        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());
        set_test_integrity_key(Some(b"test-integrity-key".to_vec()));
        save_license(&test_license(), "lic_test_nokey", "blob").unwrap();

        // Keychain key unavailable (e.g. cleared) → cannot verify the row →
        // the grace anchor is untrusted and cleared.
        set_test_integrity_key(None);
        let loaded = load_license().unwrap().unwrap();
        assert!(loaded.last_server_verified_at.is_none());
    }
}
