use serde::{Deserialize, Serialize};

/// Six scan modes exposed by the engine CLI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScanMode {
    Safe,
    Quick,
    Standard,
    Deep,
    Custom,
    Url,
}

impl ScanMode {
    pub fn engine_arg(&self) -> &'static str {
        match self {
            ScanMode::Safe => "safe",
            ScanMode::Quick => "quick",
            ScanMode::Standard => "standard",
            ScanMode::Deep => "deep",
            ScanMode::Custom => "custom",
            ScanMode::Url => "url",
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
    pub instruction: Option<String>,
}

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
    pub verified: bool,
    pub detected_at: String,
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
}

/// Summary of a scan (for the history list).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanSummary {
    pub scan_id: String,
    pub target: String,
    pub mode: ScanMode,
    pub status: ScanStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub finding_count: usize,
}

/// Detailed scan record with findings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanDetail {
    pub scan_id: String,
    pub target: String,
    pub mode: ScanMode,
    pub status: ScanStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub finding_count: usize,
    pub findings: Vec<Finding>,
}

/// Events streamed to the frontend during a scan.
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
