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
/// The desktop client must verify this signature before trusting any license
/// state. After `updateEligibleUntil` the client refuses newer builds but never
/// deactivates — `perpetualFallbackBuild` records the last build the user may
/// run indefinitely.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
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
pub struct LicenseVerificationResult {
    pub valid: bool,
    pub update_eligible: bool,
    pub license: Option<LicenseFile>,
    pub reason: Option<String>,
}

/// Response from `POST /api/licenses/activate`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivateResponse {
    pub license: LicenseFile,
    pub blob: String,
    pub license_id: String,
}

/// Response from `POST /api/licenses/verify`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyServerResponse {
    pub valid: bool,
    pub update_eligible: bool,
    pub revoked: bool,
    pub reason: Option<String>,
}

/// Client-side license status summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum LicenseStatus {
    Active {
        sku: LicenseSku,
        seat_count: u32,
        machine_count: usize,
        update_eligible_until: String,
        update_eligible: bool,
        perpetual_fallback_build: Option<String>,
    },
    ExpiredEligibility {
        update_eligible_until: String,
        perpetual_fallback_build: Option<String>,
    },
    Revoked,
    None,
}
