use serde::{Deserialize, Serialize};

/// SKU identifiers for Local licenses (mirrors @lyrashield/pricing LocalSkuId).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LicenseSku {
    IndividualLaunch,
    IndividualRegular,
    TeamPerpetual,
    TeamSubscription,
    Renewal,
    SyncAddon,
}

/// The payload that is canonically serialized and signed with ed25519.
///
/// Mirrors `LicensePayload` in `packages/licenses/src/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicensePayload {
    pub sku: LicenseSku,
    pub seat_count: u32,
    pub machine_ids: Vec<String>,
    pub update_eligible_until: String,
    pub perpetual_fallback_build: Option<String>,
}

/// The complete license file: payload plus signing metadata and the ed25519
/// signature over the canonical JSON of the payload.
///
/// Mirrors `LicenseFile` in `packages/licenses/src/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseFile {
    pub sku: LicenseSku,
    pub seat_count: u32,
    pub machine_ids: Vec<String>,
    pub update_eligible_until: String,
    pub perpetual_fallback_build: Option<String>,
    pub signing_key_id: String,
    pub signature: String,
    pub issued_at: String,
}

/// Result of verifying a license file's signature.
///
/// Mirrors `LicenseVerificationResult` in `packages/licenses/src/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseVerificationResult {
    pub valid: bool,
    pub update_eligible: bool,
    pub license: Option<LicenseFile>,
    pub reason: Option<String>,
}

/// Inner data for `POST /api/licenses/activate` — versioned v1.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateData {
    pub version: u8,
    pub license: LicenseFile,
    pub blob: String,
    pub license_id: String,
}

/// Legacy alias — keep for backwards compat in tests, now backed by ActivateData with camelCase.
pub type ActivateResponse = ActivateData;

/// Generic {success,data} envelope used by all license web routes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiSuccessEnvelope<T> {
    pub success: bool,
    pub data: T,
}

/// Inner data for `POST /api/licenses/verify` — versioned v1.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyServerResponse {
    pub version: u8,
    pub valid: bool,
    pub update_eligible: bool,
    pub revoked: bool,
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sku: Option<LicenseSku>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_eligible_until: Option<String>,
}

/// Persisted license on disk — includes immutable licenseId and version.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredLicense {
    pub version: u8,
    pub license_id: String,
    pub license: LicenseFile,
    pub blob: String,
    #[serde(default)]
    pub last_server_verified_at: Option<String>,
}

/// Client-side license status summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum LicenseStatus {
    Active {
        sku: LicenseSku,
        seat_count: u32,
        machine_count: usize,
        update_eligible_until: String,
        update_eligible: bool,
        perpetual_fallback_build: Option<String>,
        offline_grace_remaining_seconds: Option<u64>,
    },
    ExpiredEligibility {
        update_eligible_until: String,
        perpetual_fallback_build: Option<String>,
        offline_grace_remaining_seconds: Option<u64>,
    },
    OfflineGraceExpired,
    Revoked,
    None,
}

#[cfg(test)]
mod status_tests {
    use super::*;

    #[test]
    fn license_status_fields_match_frontend_camel_case_contract() {
        let status = LicenseStatus::ExpiredEligibility {
            update_eligible_until: "2026-08-23T00:00:00Z".into(),
            perpetual_fallback_build: Some("0.1.1".into()),
            offline_grace_remaining_seconds: Some(60),
        };
        let json = serde_json::to_value(status).unwrap();
        assert_eq!(json["state"], "expired_eligibility");
        assert_eq!(json["updateEligibleUntil"], "2026-08-23T00:00:00Z");
        assert_eq!(json["perpetualFallbackBuild"], "0.1.1");
        assert_eq!(json["offlineGraceRemainingSeconds"], 60);
    }
}
