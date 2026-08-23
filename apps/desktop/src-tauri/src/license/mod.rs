pub mod golden_vectors;
pub mod store;
pub mod types;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use types::{LicenseFile, LicenseVerificationResult};

pub static TEST_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Produce a deterministic JSON string for signing.
///
/// Port of `canonicalJSON` in `packages/licenses/src/sign.ts`.
///
/// Object keys are sorted lexicographically at every depth, arrays preserve
/// insertion order, and there is no insignificant whitespace. `undefined`
/// (Rust `None` for `Option`) is omitted; `null` is kept.
pub fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "null".into()),
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        serde_json::Value::Object(obj) => {
            // BTreeMap gives us lexicographic key ordering for free.
            let sorted: BTreeMap<&String, &serde_json::Value> = obj.iter().collect();
            let parts: Vec<String> = sorted
                .iter()
                .filter(|(_, v)| !is_undefined(v))
                .map(|(k, v)| {
                    let key_str = serde_json::to_string(k).unwrap_or_else(|_| "null".into());
                    format!("{}:{}", key_str, canonical_json(v))
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

/// In JS, `undefined` is omitted by canonicalJSON. In serde_json, `undefined`
/// doesn't exist — `Option::None` is serialized as `null`. We handle omission
/// at the payload-construction level (see `signing_bytes`), so this is always
/// false for values that reach `canonical_json` via the normal path. Kept for
/// parity with the JS implementation.
fn is_undefined(_value: &serde_json::Value) -> bool {
    false
}

/// The exact bytes that the ed25519 signature covers.
///
/// Port of `signingBytes` in `packages/licenses/src/sign.ts`.
/// Constructs the canonical JSON of the five payload fields only
/// (excluding signature, signingKeyId, issuedAt).
pub fn signing_bytes(payload: &serde_json::Value) -> Vec<u8> {
    canonical_json(payload).into_bytes()
}

/// Build the signing input as a `serde_json::Value` with the five payload
/// fields in the correct order for canonical serialization.
fn build_signing_input(file: &LicenseFile) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert(
        "machineIds".into(),
        serde_json::Value::Array(
            file.machine_ids
                .iter()
                .map(|id| serde_json::Value::String(id.clone()))
                .collect(),
        ),
    );
    map.insert(
        "perpetualFallbackBuild".into(),
        match &file.perpetual_fallback_build {
            Some(b) => serde_json::Value::String(b.clone()),
            None => serde_json::Value::Null,
        },
    );
    map.insert(
        "seatCount".into(),
        serde_json::Value::Number(file.seat_count.into()),
    );
    map.insert(
        "sku".into(),
        serde_json::to_value(&file.sku).unwrap_or(serde_json::Value::Null),
    );
    map.insert(
        "updateEligibleUntil".into(),
        serde_json::Value::String(file.update_eligible_until.clone()),
    );
    serde_json::Value::Object(map)
}

/// Decode a detached license blob: `<base64(canonicalJSON(payload))>.<base64(sig)>`.
///
/// Returns the decoded payload bytes (for re-verification) and the signature
/// bytes. The desktop must verify the exact received payload bytes and must
/// not re-serialize.
pub fn decode_blob(blob: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
    let parts: Vec<&str> = blob.splitn(2, '.').collect();
    if parts.len() != 2 {
        return Err("invalid blob format: expected payload.signature".into());
    }
    let payload_bytes = BASE64
        .decode(parts[0])
        .map_err(|e| format!("invalid payload base64: {}", e))?;
    let signature_bytes = BASE64
        .decode(parts[1])
        .map_err(|e| format!("invalid signature base64: {}", e))?;
    Ok((payload_bytes, signature_bytes))
}

/// Load an ed25519 public key from a SPKI PEM string.
fn load_public_key(pem: &str) -> Result<VerifyingKey, String> {
    use ed25519_dalek::pkcs8::DecodePublicKey;
    VerifyingKey::from_public_key_pem(pem).map_err(|e| format!("invalid public key PEM: {}", e))
}

/// Verify a license file's ed25519 signature against a public key (SPKI PEM).
///
/// Port of `verifyLicense` in `packages/licenses/src/verify.ts`.
///
/// Returns `{ valid, update_eligible, license, reason }`. The caller is
/// responsible for checking `update_eligible` separately from `valid` — a
/// license can be validly signed but no longer eligible for updates.
pub fn verify_license(
    license_file: &LicenseFile,
    public_key_pem: &str,
) -> LicenseVerificationResult {
    // B-L04: Validate payload field semantics before signature verification.
    let sku_str = serde_json::to_string(&license_file.sku).unwrap_or_default();
    let sku_empty = sku_str == "\"\"" || sku_str == "null" || sku_str.is_empty();
    if sku_empty {
        return LicenseVerificationResult {
            valid: false,
            update_eligible: false,
            license: None,
            reason: Some("invalid_sku".into()),
        };
    }

    if license_file.seat_count == 0 || license_file.seat_count > 10000 {
        return LicenseVerificationResult {
            valid: false,
            update_eligible: false,
            license: None,
            reason: Some("invalid_seat_count".into()),
        };
    }

    if license_file.machine_ids.iter().any(|id| id.is_empty()) {
        return LicenseVerificationResult {
            valid: false,
            update_eligible: false,
            license: None,
            reason: Some("invalid_machine_ids".into()),
        };
    }

    // Validate updateEligibleUntil is a parseable ISO date.
    let eligible_until =
        match chrono::DateTime::parse_from_rfc3339(&license_file.update_eligible_until) {
            Ok(dt) => dt.with_timezone(&chrono::Utc),
            Err(_) => {
                return LicenseVerificationResult {
                    valid: false,
                    update_eligible: false,
                    license: None,
                    reason: Some("invalid_update_eligible_until".into()),
                }
            }
        };

    if license_file.signature.is_empty()
        || license_file.signing_key_id.is_empty()
        || license_file.issued_at.is_empty()
    {
        return LicenseVerificationResult {
            valid: false,
            update_eligible: false,
            license: None,
            reason: Some("missing_signing_metadata".into()),
        };
    }

    // Reconstruct the exact signing input (five payload fields only).
    let signing_input = build_signing_input(license_file);
    let signing_bytes = signing_bytes(&signing_input);

    // Load the public key.
    let public_key = match load_public_key(public_key_pem) {
        Ok(pk) => pk,
        Err(_) => {
            return LicenseVerificationResult {
                valid: false,
                update_eligible: false,
                license: None,
                reason: Some("invalid_public_key".into()),
            }
        }
    };

    // Decode the signature.
    let signature_bytes = match BASE64.decode(license_file.signature.as_bytes()) {
        Ok(bytes) => bytes,
        Err(_) => {
            return LicenseVerificationResult {
                valid: false,
                update_eligible: false,
                license: None,
                reason: Some("invalid_signature_encoding".into()),
            }
        }
    };

    // ed25519 signatures are 64 bytes.
    if signature_bytes.len() != 64 {
        return LicenseVerificationResult {
            valid: false,
            update_eligible: false,
            license: None,
            reason: Some("invalid_signature_length".into()),
        };
    }

    let mut sig_array = [0u8; 64];
    sig_array.copy_from_slice(&signature_bytes);
    let signature = Signature::from_bytes(&sig_array);

    // Verify the signature.
    use ed25519_dalek::Verifier;
    let is_valid = public_key.verify(&signing_bytes, &signature).is_ok();

    if !is_valid {
        return LicenseVerificationResult {
            valid: false,
            update_eligible: false,
            license: None,
            reason: Some("signature_mismatch".into()),
        };
    }

    let now = chrono::Utc::now();
    let update_eligible = eligible_until > now;

    LicenseVerificationResult {
        valid: true,
        update_eligible,
        license: Some(license_file.clone()),
        reason: if update_eligible {
            None
        } else {
            Some("update_eligibility_expired".into())
        },
    }
}

/// Check whether a given build version is installable under a verified license.
///
/// Port of `isBuildInstallable` in `packages/licenses/src/verify.ts`.
///
/// - If the license is still update-eligible, any build is allowed.
/// - If eligibility has expired, only builds <= `perpetualFallbackBuild` are
///   allowed (the client never deactivates — it just refuses newer updates).
/// - Returns `false` if the fallback build is null and eligibility has expired.
pub fn is_build_installable(license_file: &LicenseFile, build_version: &str) -> bool {
    let eligible_until =
        match chrono::DateTime::parse_from_rfc3339(&license_file.update_eligible_until) {
            Ok(dt) => dt.with_timezone(&chrono::Utc),
            Err(_) => return false,
        };

    let now = chrono::Utc::now();
    let still_eligible = eligible_until > now;

    if still_eligible {
        return true;
    }

    match &license_file.perpetual_fallback_build {
        None => false,
        Some(fallback) => compare_versions(build_version, fallback) <= 0,
    }
}

/// Single guard validating signature, machine membership, and revocation before operation.
/// All failures are non-operational. Must be called BEFORE any subprocess or updater install.
#[derive(Debug)]
pub struct OperationalLicense {
    pub stored: types::StoredLicense,
    pub offline_grace_remaining_seconds: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum LicenseOperationalError {
    #[error("no stored license")]
    NoStoredLicense,
    #[error("offline grace expired; reconnect to verify the license")]
    OfflineGraceExpired,
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Unavailable(String),
}

fn refresh_server_verified_license(
    mut stored: types::StoredLicense,
    persist: impl FnOnce(&types::StoredLicense) -> Result<(), String>,
) -> OperationalLicense {
    stored.version = 2;
    stored.last_server_verified_at = Some(chrono::Utc::now().to_rfc3339());
    if persist(&stored).is_err() {
        eprintln!("failed to persist license verification timestamp");
    }
    OperationalLicense {
        stored,
        offline_grace_remaining_seconds: None,
    }
}

pub async fn ensure_license_operational(
    api_url: Option<String>,
    public_key_pem: &str,
) -> Result<OperationalLicense, LicenseOperationalError> {
    // Load persisted v1 StoredLicense with immutable licenseId.
    let stored = store::load_license()
        .map_err(|_| LicenseOperationalError::Unavailable("failed to load license".into()))?
        .ok_or(LicenseOperationalError::NoStoredLicense)?;

    if !matches!(stored.version, 1 | 2) {
        return Err(LicenseOperationalError::Invalid(format!(
            "unsupported license version: {}",
            stored.version
        )));
    }
    if stored.license_id.is_empty() {
        return Err(LicenseOperationalError::Invalid(
            "missing licenseId — re-activate required".into(),
        ));
    }

    // Local signature verification.
    let verification = verify_license(&stored.license, public_key_pem);
    if !verification.valid {
        return Err(LicenseOperationalError::Invalid(format!(
            "license signature invalid: {}",
            verification.reason.unwrap_or_else(|| "unknown".into())
        )));
    }

    // Machine binding — must be member.
    let machine_id = crate::machine_id::generate_machine_id();
    if !stored.license.machine_ids.contains(&machine_id) {
        return Err(LicenseOperationalError::Invalid(
            "machine not bound to this license".into(),
        ));
    }

    // Identified server revocation check — requires licenseId. All transport/parse failures are non-operational.
    let client = crate::api::ApiClient::new(api_url)
        .map_err(|_| LicenseOperationalError::Unavailable("failed to build api client".into()))?;
    match client.verify(&stored.license, &stored.license_id).await {
        Ok(server) => {
            if server.revoked || !server.valid {
                let _ = store::clear_license();
                return Err(LicenseOperationalError::Invalid(format!(
                    "license revoked or invalid: {}",
                    server.reason.unwrap_or_else(|| "unknown".into())
                )));
            }
            Ok(refresh_server_verified_license(stored, store::save_stored))
        }
        Err(error) => {
            if error.allows_offline_grace() {
                if let Some(remaining) =
                    offline_grace_remaining_seconds(&stored, chrono::Utc::now())
                {
                    Ok(OperationalLicense {
                        stored,
                        offline_grace_remaining_seconds: Some(remaining),
                    })
                } else {
                    Err(LicenseOperationalError::OfflineGraceExpired)
                }
            } else {
                Err(LicenseOperationalError::Unavailable(format!(
                    "license revalidation failed: {}",
                    error
                )))
            }
        }
    }
}

const OFFLINE_GRACE_DAYS: i64 = 7;
const CLOCK_SKEW_MINUTES: i64 = 5;

fn offline_grace_valid(stored: &types::StoredLicense, now: chrono::DateTime<chrono::Utc>) -> bool {
    offline_grace_remaining_seconds(stored, now).is_some()
}

fn offline_grace_remaining_seconds(
    stored: &types::StoredLicense,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<u64> {
    let Some(value) = &stored.last_server_verified_at else {
        return None;
    };
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(value) else {
        return None;
    };
    let verified_at = parsed.with_timezone(&chrono::Utc);
    if verified_at > now + chrono::Duration::minutes(CLOCK_SKEW_MINUTES) {
        return None;
    }
    let expires_at = verified_at + chrono::Duration::days(OFFLINE_GRACE_DAYS);
    let remaining = expires_at.signed_duration_since(now).num_seconds();
    (remaining > 0).then_some(remaining as u64)
}

/// Check eligibility for a specific build version under the operational license.
pub async fn ensure_update_installable(
    api_url: Option<String>,
    public_key_pem: &str,
    target_version: &str,
) -> Result<types::StoredLicense, String> {
    let operational = ensure_license_operational(api_url, public_key_pem)
        .await
        .map_err(|error| error.to_string())?;
    if !is_build_installable(&operational.stored.license, target_version) {
        return Err("target build is outside this license's update eligibility".into());
    }
    Ok(operational.stored)
}

/// Simple semver comparison: returns -1, 0, or 1.
///
/// Port of `compareVersions` in `packages/licenses/src/verify.ts`.
/// Pre-release tags like "1.2.0-beta" are stripped before numeric comparison.
/// Non-numeric segments fall back to lexicographic comparison.
fn compare_versions(a: &str, b: &str) -> i8 {
    let clean_a = a.split('-').next().unwrap_or(a);
    let clean_b = b.split('-').next().unwrap_or(b);

    let pa: Vec<&str> = clean_a.split('.').collect();
    let pb: Vec<&str> = clean_b.split('.').collect();
    let len = pa.len().max(pb.len());

    for i in 0..len {
        let na = pa.get(i).unwrap_or(&"0");
        let nb = pb.get(i).unwrap_or(&"0");
        let va: i64 = na.parse().unwrap_or(-1);
        let vb: i64 = nb.parse().unwrap_or(-1);

        // B-L03: Reject non-numeric segments — fall back to lexicographic.
        if va == -1 || vb == -1 {
            if na < nb {
                return -1;
            }
            if na > nb {
                return 1;
            }
            continue;
        }

        if va < vb {
            return -1;
        }
        if va > vb {
            return 1;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_canonical_json_object_keys_sorted() {
        let input = serde_json::json!({
            "z": 1,
            "a": 2,
            "m": "hello"
        });
        let result = canonical_json(&input);
        assert_eq!(result, r#"{"a":2,"m":"hello","z":1}"#);
    }

    #[test]
    fn test_canonical_json_array_preserves_order() {
        let input = serde_json::json!([3, 1, 2]);
        let result = canonical_json(&input);
        assert_eq!(result, "[3,1,2]");
    }

    #[test]
    fn test_canonical_json_nested() {
        let input = serde_json::json!({
            "outer": {"b": 1, "a": 2}
        });
        let result = canonical_json(&input);
        assert_eq!(result, r#"{"outer":{"a":2,"b":1}}"#);
    }

    #[test]
    fn test_canonical_json_null_preserved() {
        let input = serde_json::json!({"key": null});
        let result = canonical_json(&input);
        assert_eq!(result, r#"{"key":null}"#);
    }

    #[test]
    fn test_compare_versions_basic() {
        assert_eq!(compare_versions("1.0.0", "1.0.0"), 0);
        assert_eq!(compare_versions("1.0.0", "2.0.0"), -1);
        assert_eq!(compare_versions("2.0.0", "1.0.0"), 1);
        assert_eq!(compare_versions("1.2.0", "1.10.0"), -1);
    }

    #[test]
    fn test_compare_versions_strips_prerelease() {
        assert_eq!(compare_versions("1.2.0-beta", "1.2.0"), 0);
        assert_eq!(compare_versions("1.2.0-alpha", "1.3.0"), -1);
    }

    #[test]
    fn test_compare_versions_different_lengths() {
        assert_eq!(compare_versions("1.0", "1.0.0"), 0);
        assert_eq!(compare_versions("1.0.1", "1.0"), 1);
    }

    // === Guard tests per spec: wrong machine, revoked, expired, unknown id, unreachable, 5xx, malformed, no subprocess before guard ===

    fn test_pubkey_and_sign(file: &mut types::LicenseFile) -> String {
        use ed25519_dalek::pkcs8::EncodePublicKey;
        use ed25519_dalek::{Signer, SigningKey};
        // Generate a deterministic test key (seed 0..32)
        let seed = [1u8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key = signing_key.verifying_key();
        let pubkey_pem = verifying_key.to_public_key_pem(Default::default()).unwrap();
        // Build signing input and sign
        let mut map = serde_json::Map::new();
        map.insert(
            "machineIds".into(),
            serde_json::Value::Array(
                file.machine_ids
                    .iter()
                    .map(|id| serde_json::Value::String(id.clone()))
                    .collect(),
            ),
        );
        map.insert(
            "perpetualFallbackBuild".into(),
            match &file.perpetual_fallback_build {
                Some(b) => serde_json::Value::String(b.clone()),
                None => serde_json::Value::Null,
            },
        );
        map.insert(
            "seatCount".into(),
            serde_json::Value::Number(file.seat_count.into()),
        );
        map.insert("sku".into(), serde_json::to_value(&file.sku).unwrap());
        map.insert(
            "updateEligibleUntil".into(),
            serde_json::Value::String(file.update_eligible_until.clone()),
        );
        let payload = serde_json::Value::Object(map);
        let bytes = crate::license::canonical_json(&payload).into_bytes();
        let sig = signing_key.sign(&bytes);
        file.signature = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
        file.signing_key_id = "test-key".into();
        file.issued_at = "2026-01-01T00:00:00.000Z".into();
        pubkey_pem
    }

    fn make_valid_stored(machine_id: &str) -> (types::StoredLicense, String) {
        let mut file = types::LicenseFile {
            sku: types::LicenseSku::IndividualLaunch,
            seat_count: 1,
            machine_ids: vec![machine_id.to_string()],
            update_eligible_until: "2036-01-01T00:00:00.000Z".into(),
            perpetual_fallback_build: Some("1.2.0".into()),
            signing_key_id: String::new(),
            signature: String::new(),
            issued_at: String::new(),
        };
        let pubkey = test_pubkey_and_sign(&mut file);
        let stored = types::StoredLicense {
            version: 1,
            license_id: "lic_test_123".into(),
            license: file,
            blob: "testblob".into(),
            last_server_verified_at: None,
        };
        (stored, pubkey)
    }

    #[test]
    fn test_offline_grace_expires_at_exact_seven_day_boundary() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-08-23T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let (mut stored, _) = make_valid_stored("machine");
        stored.last_server_verified_at = Some("2026-08-16T12:00:00Z".into());
        assert!(!offline_grace_valid(&stored, now));
    }

    #[test]
    fn test_offline_grace_rejects_timestamp_older_than_seven_days() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-08-23T12:00:01Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let (mut stored, _) = make_valid_stored("machine");
        stored.last_server_verified_at = Some("2026-08-16T12:00:00Z".into());
        assert!(!offline_grace_valid(&stored, now));
    }

    #[test]
    fn test_offline_grace_rejects_clock_rollback_beyond_five_minutes() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-08-23T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let (mut stored, _) = make_valid_stored("machine");
        stored.last_server_verified_at = Some("2026-08-23T12:05:01Z".into());
        assert!(!offline_grace_valid(&stored, now));
    }

    #[test]
    fn test_offline_grace_rejects_missing_or_malformed_timestamp() {
        let now = chrono::Utc::now();
        let (mut stored, _) = make_valid_stored("machine");
        assert!(!offline_grace_valid(&stored, now));
        stored.last_server_verified_at = Some("not-a-date".into());
        assert!(!offline_grace_valid(&stored, now));
    }

    #[test]
    fn successful_server_verification_remains_operational_when_cache_write_fails() {
        let (stored, _) = make_valid_stored("machine");
        let operational = refresh_server_verified_license(stored, |_| Err("read only".into()));
        assert_eq!(operational.stored.version, 2);
        assert!(operational.stored.last_server_verified_at.is_some());
        assert_eq!(operational.offline_grace_remaining_seconds, None);
    }

    fn test_pubkey_and_sign_alias(file: &mut types::LicenseFile) -> String {
        test_pubkey_and_sign(file)
    }

    #[test]
    fn test_guard_wrong_machine_non_operational() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();
        let machine_id = crate::machine_id::generate_machine_id();
        let (mut stored, _pubkey) = make_valid_stored(&machine_id);
        // Tamper to wrong machine
        stored.license.machine_ids = vec!["wrong-machine".into()];
        // Re-sign with wrong machine so signature still valid but membership fails
        let pubkey2 = test_pubkey_and_sign(&mut stored.license);
        // Use temp dir for store
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());
        crate::license::store::save_license(&stored.license, &stored.license_id, &stored.blob)
            .unwrap();
        // Now re-load and check machine membership fails before server
        // We test verify_license still valid but ensure_license_operational should fail on machine check
        let rt = tokio::runtime::Runtime::new().unwrap();
        let res = rt.block_on(async {
            // Use a mock server that would succeed if reached, but machine check fails first
            crate::license::ensure_license_operational(Some("http://127.0.0.1:1".into()), &pubkey2)
                .await
        });
        assert!(matches!(
            res,
            Err(LicenseOperationalError::Invalid(message)) if message.contains("machine not bound")
        ));
    }

    #[test]
    fn test_guard_revoked_signature_non_operational() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();
        let machine_id = crate::machine_id::generate_machine_id();
        let (mut stored, pubkey) = make_valid_stored(&machine_id);
        stored.license.signature = "REVOKED".into();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());
        crate::license::store::save_license(&stored.license, &stored.license_id, &stored.blob)
            .unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let res = rt.block_on(async {
            crate::license::ensure_license_operational(Some("http://127.0.0.1:1".into()), &pubkey)
                .await
        });
        assert!(matches!(res, Err(LicenseOperationalError::Invalid(_))));
    }

    #[test]
    fn test_guard_expired_eligibility_keeps_current_build_operational() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();
        let machine_id = crate::machine_id::generate_machine_id();
        let (mut stored, _pubkey) = make_valid_stored(&machine_id);
        stored.license.update_eligible_until = "2020-01-01T00:00:00.000Z".into();
        // Re-sign after changing date
        let pubkey2 = test_pubkey_and_sign(&mut stored.license);
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());
        crate::license::store::save_license(&stored.license, &stored.license_id, &stored.blob)
            .unwrap();
        // Mock server that returns success
        let rt = tokio::runtime::Runtime::new().unwrap();
        let res = rt.block_on(async {
            // Start a mock server that returns valid verify response
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                if let Ok((mut stream, _)) = listener.accept().await {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 4096];
                    let _ = stream.read(&mut buf).await;
                    let body = r#"{"success":true,"data":{"version":1,"valid":true,"revoked":false,"updateEligible":true}}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                }
            });
            let url = format!("http://{}", addr);
            let result = crate::license::ensure_license_operational(Some(url), &pubkey2).await;
            // Give server time to handle
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            drop(server);
            result
        });
        assert!(res.is_ok());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn test_v1_envelope_requires_online_verification_and_rewrites_v2() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();
        let machine_id = crate::machine_id::generate_machine_id();
        let (mut stored, pubkey) = make_valid_stored(&machine_id);
        stored.version = 1;
        stored.last_server_verified_at = None;
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());
        crate::license::store::save_stored(&stored).unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let body = r#"{"success":true,"data":{"version":1,"valid":true,"revoked":false,"updateEligible":true}}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });

        let operational =
            crate::license::ensure_license_operational(Some(format!("http://{}", addr)), &pubkey)
                .await
                .unwrap();
        assert_eq!(operational.stored.version, 2);
        assert!(operational.stored.last_server_verified_at.is_some());
        let reloaded = crate::license::store::load_license().unwrap().unwrap();
        assert_eq!(reloaded.version, 2);
        assert!(reloaded.last_server_verified_at.is_some());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn test_guard_unreachable_uses_fresh_offline_grace() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();
        let machine_id = crate::machine_id::generate_machine_id();
        let (stored, pubkey) = make_valid_stored(&machine_id);
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());
        crate::license::store::save_license(&stored.license, &stored.license_id, &stored.blob)
            .unwrap();
        // Use an unreachable address (port 1 is typically closed)
        let res =
            crate::license::ensure_license_operational(Some("http://127.0.0.1:1".into()), &pubkey)
                .await;
        assert!(res.is_ok());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn test_guard_5xx_uses_fresh_offline_grace() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();
        let machine_id = crate::machine_id::generate_machine_id();
        let (stored, pubkey) = make_valid_stored(&machine_id);
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());
        crate::license::store::save_license(&stored.license, &stored.license_id, &stored.blob)
            .unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let body =
                    r#"{"success":false,"error":{"code":"INTERNAL_ERROR","message":"oops"}}"#;
                let resp = format!(
                    "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            }
        });
        let url = format!("http://{}", addr);
        let res = crate::license::ensure_license_operational(Some(url), &pubkey).await;
        assert!(res.is_ok());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn test_guard_malformed_non_operational() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();
        let machine_id = crate::machine_id::generate_machine_id();
        let (stored, pubkey) = make_valid_stored(&machine_id);
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());
        crate::license::store::save_license(&stored.license, &stored.license_id, &stored.blob)
            .unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let body = r#"not json at all"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            }
        });
        let url = format!("http://{}", addr);
        let res = crate::license::ensure_license_operational(Some(url), &pubkey).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn test_guard_unknown_id_non_operational() {
        let _lock = crate::license::TEST_ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();
        let machine_id = crate::machine_id::generate_machine_id();
        let (stored, pubkey) = make_valid_stored(&machine_id);
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("XDG_DATA_HOME", tmp.path());
        crate::license::store::save_license(&stored.license, &stored.license_id, &stored.blob)
            .unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let body = r#"{"success":true,"data":{"version":1,"valid":false,"revoked":true,"updateEligible":false,"reason":"UNKNOWN_LICENSE"}}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            }
        });
        let url = format!("http://{}", addr);
        let res = crate::license::ensure_license_operational(Some(url), &pubkey).await;
        assert!(matches!(res, Err(LicenseOperationalError::Invalid(_))));
    }

    #[test]
    fn test_no_subprocess_before_guard() {
        // Ensure the guard is the first side effect in start_scan — no Command::new before ensure_license_operational.
        let src = include_str!("../commands.rs");
        let guard_pos = src
            .find("ensure_license_operational")
            .expect("guard must exist");
        let spawn_pos = src.find("Command::new").unwrap_or(usize::MAX);
        // The scan runner spawn is in scan/mod.rs; but commands.rs must gate before calling scan::start_scan.
        // Check that ensure_license_operational appears before scan::start_scan
        let scan_call = src.find("scan::start_scan").expect("scan call must exist");
        assert!(guard_pos < scan_call, "guard must be before scan spawn");
        // Also ensure no direct process spawn in commands.rs before guard
        if spawn_pos != usize::MAX {
            assert!(guard_pos < spawn_pos, "guard must be before any subprocess");
        }
    }
}
