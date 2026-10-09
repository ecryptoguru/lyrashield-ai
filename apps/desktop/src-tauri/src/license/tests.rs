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
        revalidation_receipt: None,
    };
    (stored, pubkey)
}

fn sign_test_receipt(
    stored: &types::StoredLicense,
    verified_at: &str,
    expires_at: &str,
) -> types::LicenseRevalidationReceipt {
    use ed25519_dalek::{Signer, SigningKey};
    let payload = serde_json::json!({
        "licenseId": stored.license_id,
        "licenseSignature": stored.license.signature,
        "verifiedAt": verified_at,
        "expiresAt": expires_at,
    });
    let signature = SigningKey::from_bytes(&[1u8; 32]).sign(canonical_json(&payload).as_bytes());
    types::LicenseRevalidationReceipt {
        license_id: stored.license_id.clone(),
        license_signature: stored.license.signature.clone(),
        verified_at: verified_at.into(),
        expires_at: expires_at.into(),
        signing_key_id: "test-key".into(),
        signature: BASE64.encode(signature.to_bytes()),
    }
}

fn verified_server_body(stored: &types::StoredLicense) -> String {
    let verified_at = chrono::Utc::now();
    let receipt = sign_test_receipt(
        stored,
        &verified_at.to_rfc3339(),
        &(verified_at + chrono::Duration::days(7)).to_rfc3339(),
    );
    serde_json::json!({
        "success": true,
        "data": {
            "version": 1,
            "valid": true,
            "revoked": false,
            "updateEligible": true,
            "revalidationReceipt": receipt,
        }
    })
    .to_string()
}

fn guard_lock() -> std::sync::MutexGuard<'static, ()> {
    crate::license::TEST_ENV_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap()
}

#[test]
fn test_offline_grace_expires_at_exact_seven_day_boundary() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-08-23T12:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let (mut stored, pubkey) = make_valid_stored("machine");
    stored.revalidation_receipt = Some(sign_test_receipt(
        &stored,
        "2026-08-16T12:00:00Z",
        "2026-08-23T12:00:00Z",
    ));
    assert!(!offline_grace_valid(&stored, &pubkey, now));
}

#[test]
fn test_offline_grace_rejects_timestamp_older_than_seven_days() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-08-23T12:00:01Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let (mut stored, pubkey) = make_valid_stored("machine");
    stored.revalidation_receipt = Some(sign_test_receipt(
        &stored,
        "2026-08-16T12:00:00Z",
        "2026-08-23T12:00:00Z",
    ));
    assert!(!offline_grace_valid(&stored, &pubkey, now));
}

#[test]
fn test_offline_grace_rejects_clock_rollback_beyond_five_minutes() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-08-23T12:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let (mut stored, pubkey) = make_valid_stored("machine");
    stored.revalidation_receipt = Some(sign_test_receipt(
        &stored,
        "2026-08-23T12:05:01Z",
        "2026-08-30T12:05:01Z",
    ));
    assert!(!offline_grace_valid(&stored, &pubkey, now));
}

#[test]
fn test_offline_grace_rejects_missing_or_malformed_timestamp() {
    let now = chrono::Utc::now();
    let (mut stored, pubkey) = make_valid_stored("machine");
    assert!(!offline_grace_valid(&stored, &pubkey, now));
    stored.last_server_verified_at = Some("not-a-date".into());
    assert!(!offline_grace_valid(&stored, &pubkey, now));
}

#[test]
fn test_tampered_revalidation_receipt_cannot_extend_offline_grace() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-09-11T12:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let (mut stored, pubkey) = make_valid_stored("machine");
    let mut receipt = sign_test_receipt(&stored, "2026-09-01T12:00:00Z", "2026-09-08T12:00:00Z");
    receipt.verified_at = "2026-09-11T12:00:00Z".into();
    receipt.expires_at = "2026-09-18T12:00:00Z".into();
    stored.revalidation_receipt = Some(receipt);
    stored.last_server_verified_at = Some("2026-09-11T12:00:00Z".into());

    assert!(!offline_grace_valid(&stored, &pubkey, now));
}

#[test]
fn successful_server_verification_remains_operational_when_cache_write_fails() {
    let (stored, pubkey) = make_valid_stored("machine");
    let body = verified_server_body(&stored);
    let response: serde_json::Value = serde_json::from_str(&body).unwrap();
    let receipt = serde_json::from_value(response["data"]["revalidationReceipt"].clone()).unwrap();
    let operational =
        refresh_server_verified_license(stored, receipt, &pubkey, |_| Err("read only".into()))
            .unwrap();
    assert_eq!(operational.stored.version, 2);
    assert!(operational.stored.last_server_verified_at.is_some());
    assert_eq!(operational.offline_grace_remaining_seconds, None);
}

/// Backwards-compatible name for `test_pubkey_and_sign`, retained for the
/// alias check in the golden-vector parity suite.
#[allow(dead_code)]
fn test_pubkey_and_sign_alias(file: &mut types::LicenseFile) -> String {
    test_pubkey_and_sign(file)
}

#[test]
fn test_guard_wrong_machine_non_operational() {
    let _lock = guard_lock();
    let machine_id = crate::machine_id::generate_machine_id().unwrap();
    let (mut stored, _pubkey) = make_valid_stored(&machine_id);
    // Tamper to wrong machine
    stored.license.machine_ids = vec!["wrong-machine".into()];
    // Re-sign with wrong machine so signature still valid but membership fails
    let pubkey2 = test_pubkey_and_sign(&mut stored.license);
    // Use temp dir for store
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", tmp.path());
    std::env::set_var("XDG_DATA_HOME", tmp.path());
    crate::license::store::save_license(&stored.license, &stored.license_id, &stored.blob).unwrap();
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
    let _lock = guard_lock();
    let machine_id = crate::machine_id::generate_machine_id().unwrap();
    let (mut stored, pubkey) = make_valid_stored(&machine_id);
    stored.license.signature = "REVOKED".into();
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", tmp.path());
    std::env::set_var("XDG_DATA_HOME", tmp.path());
    crate::license::store::save_license(&stored.license, &stored.license_id, &stored.blob).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let res = rt.block_on(async {
        crate::license::ensure_license_operational(Some("http://127.0.0.1:1".into()), &pubkey).await
    });
    assert!(matches!(res, Err(LicenseOperationalError::Invalid(_))));
}

#[test]
fn test_guard_expired_eligibility_keeps_current_build_operational() {
    let _lock = guard_lock();
    let machine_id = crate::machine_id::generate_machine_id().unwrap();
    let (mut stored, _pubkey) = make_valid_stored(&machine_id);
    stored.license.update_eligible_until = "2020-01-01T00:00:00.000Z".into();
    // Re-sign after changing date
    let pubkey2 = test_pubkey_and_sign(&mut stored.license);
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", tmp.path());
    std::env::set_var("XDG_DATA_HOME", tmp.path());
    crate::license::store::save_license(&stored.license, &stored.license_id, &stored.blob).unwrap();
    let body = verified_server_body(&stored);
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
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(), body
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
    let _lock = guard_lock();
    let machine_id = crate::machine_id::generate_machine_id().unwrap();
    let (mut stored, pubkey) = make_valid_stored(&machine_id);
    stored.version = 1;
    stored.last_server_verified_at = None;
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", tmp.path());
    std::env::set_var("XDG_DATA_HOME", tmp.path());
    crate::license::store::save_stored(&stored).unwrap();
    let body = verified_server_body(&stored);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf).await;
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
    let _lock = guard_lock();
    let machine_id = crate::machine_id::generate_machine_id().unwrap();
    let (mut stored, pubkey) = make_valid_stored(&machine_id);
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", tmp.path());
    std::env::set_var("XDG_DATA_HOME", tmp.path());
    let now = chrono::Utc::now();
    stored.revalidation_receipt = Some(sign_test_receipt(
        &stored,
        &now.to_rfc3339(),
        &(now + chrono::Duration::days(7)).to_rfc3339(),
    ));
    stored.last_server_verified_at = Some(now.to_rfc3339());
    crate::license::store::save_stored(&stored).unwrap();
    // Use an unreachable address (port 1 is typically closed)
    let res =
        crate::license::ensure_license_operational(Some("http://127.0.0.1:1".into()), &pubkey)
            .await;
    assert!(res.is_ok());
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn test_guard_5xx_uses_fresh_offline_grace() {
    let _lock = guard_lock();
    let machine_id = crate::machine_id::generate_machine_id().unwrap();
    let (mut stored, pubkey) = make_valid_stored(&machine_id);
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", tmp.path());
    std::env::set_var("XDG_DATA_HOME", tmp.path());
    let now = chrono::Utc::now();
    stored.revalidation_receipt = Some(sign_test_receipt(
        &stored,
        &now.to_rfc3339(),
        &(now + chrono::Duration::days(7)).to_rfc3339(),
    ));
    stored.last_server_verified_at = Some(now.to_rfc3339());
    crate::license::store::save_stored(&stored).unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf).await;
            let body = r#"{"success":false,"error":{"code":"INTERNAL_ERROR","message":"oops"}}"#;
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
    let _lock = guard_lock();
    let machine_id = crate::machine_id::generate_machine_id().unwrap();
    let (stored, pubkey) = make_valid_stored(&machine_id);
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", tmp.path());
    std::env::set_var("XDG_DATA_HOME", tmp.path());
    crate::license::store::save_license(&stored.license, &stored.license_id, &stored.blob).unwrap();

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
    let _lock = guard_lock();
    let machine_id = crate::machine_id::generate_machine_id().unwrap();
    let (stored, pubkey) = make_valid_stored(&machine_id);
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", tmp.path());
    std::env::set_var("XDG_DATA_HOME", tmp.path());
    crate::license::store::save_license(&stored.license, &stored.license_id, &stored.blob).unwrap();

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
    assert!(
        crate::license::store::load_license().unwrap().is_none(),
        "server-revoked license must be removed from local storage"
    );
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
