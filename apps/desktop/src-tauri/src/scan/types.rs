use serde::{Deserialize, Serialize};

/// Scan modes as persisted by the desktop client.
///
/// `Quick`, `Standard`, and `Deep` are the public depths — the only values a
/// new launch may select. `Safe` and `Custom` are unambiguous legacy aliases
/// that normalize onto Quick and Deep at validated boundaries. `Url` is a
/// retired historical record kind: a URL is a target, never an engine scan
/// mode. `Unknown` covers stored records whose mode no longer parses, so
/// history never silently shows a tier the scan did not run as. Both stay
/// viewable but can never produce an engine argument.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScanMode {
    Safe,
    Quick,
    Standard,
    Deep,
    Custom,
    Url,
    #[serde(other)]
    Unknown,
}

impl ScanMode {
    /// Canonical engine `--scan-mode` argument for a new launch. The engine
    /// only accepts `quick`, `standard`, and `deep`; obsolete or ambiguous
    /// stored modes are rejected here instead of silently picking a tier.
    pub fn engine_arg(&self) -> Result<&'static str, String> {
        match self {
            ScanMode::Safe | ScanMode::Quick => Ok("quick"),
            ScanMode::Standard => Ok("standard"),
            ScanMode::Deep | ScanMode::Custom => Ok("deep"),
            ScanMode::Url => Err(
                "'url' is a target kind, not a scan depth — choose Quick, Standard, or Deep".into(),
            ),
            ScanMode::Unknown => {
                Err("unrecognized scan mode — choose Quick, Standard, or Deep".into())
            }
        }
    }

    /// Canonical API depth token for hosted submissions (QUICK/STANDARD/DEEP).
    /// Same contract as `engine_arg`, different vocabulary — the hosted API
    /// and the engine both reject retired/ambiguous modes at their own
    /// boundaries too.
    pub fn api_depth(&self) -> Result<&'static str, String> {
        match self.engine_arg()? {
            "quick" => Ok("QUICK"),
            "standard" => Ok("STANDARD"),
            "deep" => Ok("DEEP"),
            _ => unreachable!(),
        }
    }

    /// Normalize a persisted mode token for display. Stored rows may be
    /// JSON-quoted (`"deep"`) or bare legacy strings (`deep`). Unambiguous
    /// aliases migrate to the canonical depth they actually ran as; `url` and
    /// unrecognized values stay non-launchable historical records.
    pub fn from_stored(raw: &str) -> ScanMode {
        let token = raw.trim().trim_matches('"').trim().to_ascii_lowercase();
        match token.as_str() {
            "safe" | "quick" => ScanMode::Quick,
            "standard" => ScanMode::Standard,
            "deep" | "custom" => ScanMode::Deep,
            "url" => ScanMode::Url,
            _ => ScanMode::Unknown,
        }
    }
}

/// Recorded workflow for a launch — mirrors the shared contract
/// (`packages/types/src/scan-execution-plan.ts`). `ReviewTarget` is the
/// full/snapshot review; `ReviewChanges` is the diff-scoped review that pins
/// the caller-supplied base/head refs. `AUTHENTICATED_ASSESSMENT` is
/// hosted-only and is never offered here — no local substitute exists.
/// `Unknown` covers stored rows written before workflow tracking so history
/// never silently claims a workflow the scan did not run as.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum ScanWorkflow {
    #[serde(rename = "REVIEW_TARGET")]
    #[default]
    ReviewTarget,
    #[serde(rename = "REVIEW_CHANGES")]
    ReviewChanges,
    #[serde(other)]
    Unknown,
}

impl ScanWorkflow {
    /// Canonical contract token — the same value the API/SDK/CLI/MCP use.
    pub fn as_str(&self) -> &'static str {
        match self {
            ScanWorkflow::ReviewTarget => "REVIEW_TARGET",
            ScanWorkflow::ReviewChanges => "REVIEW_CHANGES",
            ScanWorkflow::Unknown => "unknown",
        }
    }

    /// Normalize a persisted token; unrecognized values are `Unknown`, never
    /// silently ReviewTarget.
    pub fn from_stored(raw: &str) -> ScanWorkflow {
        match raw.trim().trim_matches('"') {
            "REVIEW_TARGET" => ScanWorkflow::ReviewTarget,
            "REVIEW_CHANGES" => ScanWorkflow::ReviewChanges,
            _ => ScanWorkflow::Unknown,
        }
    }
}

/// Target specification for a scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ScanTarget {
    Repo {
        path: String,
        branch: Option<String>,
    },
    Url {
        url: String,
    },
    LocalPath {
        path: String,
    },
}

impl ScanTarget {
    pub fn target_arg(&self) -> String {
        match self {
            ScanTarget::Repo { path, .. } => path.clone(),
            ScanTarget::Url { url } => url.clone(),
            ScanTarget::LocalPath { path } => path.clone(),
        }
    }
}

/// Configuration for a scan launch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanConfig {
    pub scan_id: String,
    pub target: ScanTarget,
    pub mode: ScanMode,
    /// Explicit workflow — never inferred from the target shape.
    #[serde(default)]
    pub workflow: ScanWorkflow,
    /// Review Changes comparison base — a branch name or commit SHA the local
    /// engine resolves against the checked-out repository. Required when
    /// `workflow` is `ReviewChanges`; meaningless otherwise.
    #[serde(default)]
    pub diff_base: Option<String>,
    /// Review Changes comparison head. Defaults to the checkout's HEAD.
    #[serde(default)]
    pub diff_head: Option<String>,
    pub instruction: Option<String>,
    pub max_budget_usd: f64,
}

/// The only verification tier a local engine run can produce. DETECTED is a
/// recorded observation — never VALIDATED or VERIFIED.
pub const VERIFICATION_STATE_DETECTED: &str = "DETECTED";

/// A single finding from the engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    pub id: String,
    pub severity: String,
    pub title: String,
    pub description: Option<String>,
    pub file_path: Option<String>,
    pub line_number: Option<u32>,
    pub status: String,
    /// Legacy summary flag — always false locally: the engine's own
    /// `verified` output is an unverified attestation, never a promotion.
    pub verified: bool,
    /// Authoritative verification tier — always `DETECTED` for a local run.
    #[serde(default = "detected_verification_state")]
    pub verification_state: String,
    /// True when the engine emitted attestation fields (a `verified` claim,
    /// fix_verification, counterevidence, exchange refs) that have not been
    /// exported for upstream verification. Rendered as "engine-attested —
    /// evidence export pending"; never presented as verified.
    #[serde(default)]
    pub evidence_pending: bool,
    #[serde(default)]
    pub counterevidence: Option<String>,
    #[serde(default)]
    pub confidence_rationale: Option<String>,
    /// Engine attestation of a fix check — serialized JSON or statement.
    #[serde(default)]
    pub fix_verification: Option<String>,
    #[serde(default)]
    pub http_exchange_ids: Vec<String>,
    pub detected_at: String,
}

fn detected_verification_state() -> String {
    VERIFICATION_STATE_DETECTED.to_string()
}

/// Scan status as tracked locally.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScanStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
    /// Recorded scan submitted to LyraShield Cloud — progress and evidence
    /// live server-side; the desktop never fakes local execution for it.
    Submitted,
}

/// Summary of a scan (for the history list).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanSummary {
    pub scan_id: String,
    pub target: String,
    pub mode: ScanMode,
    /// Recorded workflow (`REVIEW_TARGET`/`REVIEW_CHANGES`); `unknown` only on
    /// rows written before workflow tracking.
    #[serde(default)]
    pub workflow: ScanWorkflow,
    /// Execution backend: `local` (bundled BYOK engine) or `cloud` (hosted
    /// recorded scan). Rows written before this field are local runs.
    #[serde(default = "local_backend")]
    pub backend: String,
    /// Engine run contract observed (`strix_runs/<run>/run.json`
    /// `schema_version`, e.g. "1.1"). NULL means unknown — never guessed.
    #[serde(default)]
    pub contract_version: Option<String>,
    /// Recorded Review Changes base ref; NULL for snapshot reviews.
    #[serde(default)]
    pub diff_base: Option<String>,
    /// Recorded Review Changes head ref; NULL when the checkout HEAD applied.
    #[serde(default)]
    pub diff_head: Option<String>,
    pub status: ScanStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub finding_count: usize,
}

fn local_backend() -> String {
    "local".to_string()
}

/// Detailed scan record with findings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanDetail {
    pub scan_id: String,
    pub target: String,
    pub mode: ScanMode,
    #[serde(default)]
    pub workflow: ScanWorkflow,
    #[serde(default = "local_backend")]
    pub backend: String,
    #[serde(default)]
    pub contract_version: Option<String>,
    #[serde(default)]
    pub diff_base: Option<String>,
    #[serde(default)]
    pub diff_head: Option<String>,
    pub status: ScanStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub finding_count: usize,
    pub findings: Vec<Finding>,
}

/// Events streamed to the frontend during a scan.
// Finding variants carry the full finding record — a few hundred bytes per
// buffered event is deliberate; boxing would add indirection without changing
// the wire shape or meaningfully reducing total memory.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ScanEvent {
    Started {
        scan_id: String,
    },
    Progress {
        scan_id: String,
        line: String,
        stream: String,
    },
    Finding {
        scan_id: String,
        finding: Finding,
    },
    Completed {
        scan_id: String,
        exit_code: i32,
        finding_count: usize,
    },
    Failed {
        scan_id: String,
        error: String,
    },
    Cancelled {
        scan_id: String,
    },
}

/// Persisted scan event with monotonic sequence number for replay-from-zero.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequencedEvent {
    pub seq: u64,
    pub event: ScanEvent,
}

/// Terminal crash codes for durable terminal state mapping.
#[derive(Debug, Clone, Copy)]
pub enum CrashCode {
    SpawnFailed = 100,
    PersistenceFailed = 101,
    Cancelled = 102,
    EngineCrash = 103,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The checked-in fixture is generated from `packages/types` profile data
    /// (`scanDepthContract()`); the TS suite asserts it never drifts. This test
    /// proves the Rust side honors the same contract — it is a consumed
    /// fixture, not a second hand-maintained table.
    fn depth_contract_fixture() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../../../packages/types/src/fixtures/scan-depths.json"
        ))
        .expect("scan-depths fixture parses")
    }

    #[test]
    fn engine_args_match_the_shared_depth_contract() {
        assert_eq!(ScanMode::Safe.engine_arg().unwrap(), "quick");
        assert_eq!(ScanMode::Quick.engine_arg().unwrap(), "quick");
        assert_eq!(ScanMode::Standard.engine_arg().unwrap(), "standard");
        assert_eq!(ScanMode::Deep.engine_arg().unwrap(), "deep");
        assert_eq!(ScanMode::Custom.engine_arg().unwrap(), "deep");

        // Every stored alias in the shared contract resolves to the same
        // engine argument the enum produces.
        let fixture = depth_contract_fixture();
        let aliases = fixture["storedModeEngineArgs"].as_object().unwrap();
        for (stored, engine_arg) in aliases {
            let mode: ScanMode =
                serde_json::from_str(&format!("\"{}\"", stored)).expect("stored alias parses");
            assert_eq!(
                mode.engine_arg().unwrap(),
                engine_arg.as_str().unwrap(),
                "stored alias {stored} must map to the contracted engine argument"
            );
        }
        assert!(aliases
            .keys()
            .all(|k| ["safe", "quick", "standard", "deep", "custom"].contains(&k.as_str())));
        // The contract offers exactly the three public depths.
        let depths: Vec<&str> = fixture["publicDepths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d.as_str().unwrap())
            .collect();
        assert_eq!(depths, ["QUICK", "STANDARD", "DEEP"]);
    }

    #[test]
    fn obsolete_url_mode_is_rejected_before_any_engine_argument() {
        // `url` is a target kind, never an engine `--scan-mode`; the contract
        // fixture must not define it and the enum must refuse to produce it.
        let fixture = depth_contract_fixture();
        assert!(!fixture["storedModeEngineArgs"]
            .as_object()
            .unwrap()
            .contains_key("url"));
        assert!(ScanMode::Url.engine_arg().is_err());
        assert!(ScanMode::Unknown.engine_arg().is_err());
    }

    #[test]
    fn stored_aliases_migrate_unambiguously_and_url_stays_viewable() {
        // JSON-quoted values written by create_scan and bare legacy strings.
        assert_eq!(ScanMode::from_stored("\"safe\""), ScanMode::Quick);
        assert_eq!(ScanMode::from_stored("safe"), ScanMode::Quick);
        assert_eq!(ScanMode::from_stored("\"quick\""), ScanMode::Quick);
        assert_eq!(ScanMode::from_stored("\"standard\""), ScanMode::Standard);
        assert_eq!(ScanMode::from_stored("standard"), ScanMode::Standard);
        assert_eq!(ScanMode::from_stored("\"deep\""), ScanMode::Deep);
        assert_eq!(ScanMode::from_stored("\"custom\""), ScanMode::Deep);
        // Ambiguous historical Url records remain viewable but cannot launch.
        assert_eq!(ScanMode::from_stored("\"url\""), ScanMode::Url);
        assert!(ScanMode::from_stored("\"url\"").engine_arg().is_err());
        // Unrecognized stored values never silently become a valid tier.
        assert_eq!(ScanMode::from_stored("\"pentest\""), ScanMode::Unknown);
        assert_eq!(ScanMode::from_stored(""), ScanMode::Unknown);
        assert!(ScanMode::Unknown.engine_arg().is_err());
    }

    #[test]
    fn unknown_deserializes_instead_of_failing_history_reads() {
        let mode: ScanMode = serde_json::from_str("\"retired-mode\"").unwrap();
        assert_eq!(mode, ScanMode::Unknown);
        assert_eq!(
            serde_json::to_string(&ScanMode::Unknown).unwrap(),
            "\"unknown\""
        );
    }
}
