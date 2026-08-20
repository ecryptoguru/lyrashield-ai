use crate::license::types::{LicenseFile, LicenseSku};
use serde::Deserialize;

/// Golden vector from `packages/licenses/src/golden-license.json`.
///
/// This is a throwaway test-only ed25519 vector. Node signs canonicalJSON;
/// Rust verifies the exact received bytes. The Rust implementation must
/// produce the same result as the JS implementation.
const GOLDEN_JSON: &str = include_str!("../../../../../packages/licenses/src/golden-license.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenVector {
    payload: serde_json::Value,
    canonical_json: String,
    blob: String,
    pubkey_pem: String,
}

fn load_golden() -> GoldenVector {
    serde_json::from_str(GOLDEN_JSON).expect("golden-license.json must parse")
}

/// Reconstruct a LicenseFile from the golden payload + dummy signing metadata.
/// The signature is extracted from the blob.
fn golden_license_file(golden: &GoldenVector) -> LicenseFile {
    let payload = &golden.payload;
    let sku_str = payload["sku"]
        .as_str()
        .expect("golden payload has sku string");

    let sku = match sku_str {
        "individual_launch" => LicenseSku::IndividualLaunch,
        "individual_regular" => LicenseSku::IndividualRegular,
        "team_perpetual" => LicenseSku::TeamPerpetual,
        "team_subscription" => LicenseSku::TeamSubscription,
        "renewal" => LicenseSku::Renewal,
        "sync_addon" => LicenseSku::SyncAddon,
        other => panic!("unknown golden SKU: {}", other),
    };

    // Extract signature from the blob (second half after the dot).
    let parts: Vec<&str> = golden.blob.splitn(2, '.').collect();
    let signature = parts[1].to_string();

    LicenseFile {
        sku,
        seat_count: payload["seatCount"].as_u64().expect("seatCount") as u32,
        machine_ids: payload["machineIds"]
            .as_array()
            .expect("machineIds array")
            .iter()
            .map(|v| v.as_str().expect("machineId string").to_string())
            .collect(),
        update_eligible_until: payload["updateEligibleUntil"]
            .as_str()
            .expect("updateEligibleUntil")
            .to_string(),
        perpetual_fallback_build: payload["perpetualFallbackBuild"]
            .as_str()
            .map(|s| s.to_string()),
        signing_key_id: "golden-test-key".into(),
        signature,
        issued_at: "2026-01-01T00:00:00.000Z".into(),
    }
}

#[test]
fn test_golden_canonical_json_matches() {
    let golden = load_golden();
    let canonical = crate::license::canonical_json(&golden.payload);
    assert_eq!(
        canonical, golden.canonical_json,
        "Rust canonical_json must match the JS golden vector byte-for-byte"
    );
}

#[test]
fn test_golden_blob_payload_matches_canonical_json() {
    let golden = load_golden();
    let (payload_bytes, _) =
        crate::license::decode_blob(&golden.blob).expect("golden blob must decode");
    let payload_str = String::from_utf8(payload_bytes).expect("payload is UTF-8");
    assert_eq!(
        payload_str, golden.canonical_json,
        "Decoded blob payload must match canonical_json exactly"
    );
}

#[test]
fn test_golden_license_verifies() {
    let golden = load_golden();
    let license_file = golden_license_file(&golden);
    let result = crate::license::verify_license(&license_file, &golden.pubkey_pem);
    assert!(
        result.valid,
        "Golden license must verify against the golden public key. Reason: {:?}",
        result.reason
    );
    assert!(
        result.update_eligible,
        "Golden license update eligibility is 2036-01-01, should be eligible"
    );
}

#[test]
fn test_golden_tampered_seat_count_fails() {
    let golden = load_golden();
    let mut license_file = golden_license_file(&golden);
    license_file.seat_count = 99; // Tamper — signature no longer matches
    let result = crate::license::verify_license(&license_file, &golden.pubkey_pem);
    assert!(!result.valid, "Tampered seatCount must fail verification");
    assert_eq!(
        result.reason,
        Some("signature_mismatch".into()),
        "Tampered license must report signature_mismatch"
    );
}

#[test]
fn test_golden_tampered_sku_fails() {
    let golden = load_golden();
    let mut license_file = golden_license_file(&golden);
    license_file.sku = LicenseSku::TeamPerpetual; // Different SKU
    let result = crate::license::verify_license(&license_file, &golden.pubkey_pem);
    assert!(!result.valid, "Tampered SKU must fail verification");
    assert_eq!(result.reason, Some("signature_mismatch".into()));
}

#[test]
fn test_revoked_license_hard_stops() {
    let golden = load_golden();
    let mut license_file = golden_license_file(&golden);
    // A revoked license has signature set to "REVOKED" server-side.
    // This fails signature verification (not a valid ed25519 signature).
    license_file.signature = "REVOKED".to_string();
    let result = crate::license::verify_license(&license_file, &golden.pubkey_pem);
    assert!(
        !result.valid,
        "Revoked license (signature=REVOKED) must fail verification"
    );
    // The failure reason is invalid_signature_encoding because "REVOKED" is
    // not valid base64 for a 64-byte signature. This is correct — the
    // revocation mechanism replaces the signature with a non-verifiable value.
    assert!(result.reason.is_some());
}

#[test]
fn test_is_build_installable_eligible() {
    let golden = load_golden();
    let license_file = golden_license_file(&golden);
    // Golden license is eligible until 2036, so any build installs.
    assert!(crate::license::is_build_installable(
        &license_file,
        "99.0.0"
    ));
    assert!(crate::license::is_build_installable(&license_file, "1.0.0"));
}

#[test]
fn test_is_build_installable_expired_within_fallback() {
    let golden = load_golden();
    let mut license_file = golden_license_file(&golden);
    // Set eligibility to the past — expired.
    license_file.update_eligible_until = "2020-01-01T00:00:00.000Z".into();
    license_file.perpetual_fallback_build = Some("1.2.0".into());

    // Build <= fallback → installable.
    assert!(crate::license::is_build_installable(&license_file, "1.0.0"));
    assert!(crate::license::is_build_installable(&license_file, "1.2.0"));
}

#[test]
fn test_is_build_installable_expired_past_fallback() {
    let golden = load_golden();
    let mut license_file = golden_license_file(&golden);
    license_file.update_eligible_until = "2020-01-01T00:00:00.000Z".into();
    license_file.perpetual_fallback_build = Some("1.2.0".into());

    // Build > fallback → not installable.
    assert!(!crate::license::is_build_installable(
        &license_file,
        "1.3.0"
    ));
    assert!(!crate::license::is_build_installable(
        &license_file,
        "2.0.0"
    ));
}

#[test]
fn test_is_build_installable_expired_no_fallback() {
    let golden = load_golden();
    let mut license_file = golden_license_file(&golden);
    license_file.update_eligible_until = "2020-01-01T00:00:00.000Z".into();
    license_file.perpetual_fallback_build = None;

    // No fallback → nothing installable after expiry.
    assert!(!crate::license::is_build_installable(
        &license_file,
        "1.0.0"
    ));
}

#[test]
fn test_is_build_installable_strips_prerelease() {
    let golden = load_golden();
    let mut license_file = golden_license_file(&golden);
    license_file.update_eligible_until = "2020-01-01T00:00:00.000Z".into();
    license_file.perpetual_fallback_build = Some("1.2.0".into());

    // Pre-release tag stripped: "1.2.0-beta" == "1.2.0" → installable.
    assert!(crate::license::is_build_installable(
        &license_file,
        "1.2.0-beta"
    ));
    // "1.3.0-beta" stripped to "1.3.0" > "1.2.0" → not installable.
    assert!(!crate::license::is_build_installable(
        &license_file,
        "1.3.0-beta"
    ));
}
