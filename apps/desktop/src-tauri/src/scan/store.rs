use crate::scan::types::*;
use std::sync::Arc;
use tauri_plugin_sql::{Migration, MigrationKind};

/// Database migrations for the scan store.
pub fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create scans and findings tables",
        sql: include_str!("../sql/001_init.sql"),
        kind: MigrationKind::Up,
    }]
}

/// Save a scan result to the local SQLite database.
pub async fn save_scan_result(
    scan_id: &str,
    target: &str,
    mode: &ScanMode,
    status: ScanStatus,
    findings: &[Finding],
) -> Result<(), String> {
    let db = open_db().await?;

    let now = chrono::Utc::now().to_rfc3339();
    let mode_str = serde_json::to_string(mode).map_err(|e| format!("serialize mode: {}", e))?;
    let status_str =
        serde_json::to_string(&status).map_err(|e| format!("serialize status: {}", e))?;

    // Insert or update the scan record.
    sql_execute(
        &db,
        "INSERT OR REPLACE INTO scans (scan_id, target, mode, status, started_at, completed_at, finding_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
        &[
            scan_id.into(),
            target.into(),
            mode_str.into(),
            status_str.into(),
            now.clone().into(),
            (if status == ScanStatus::Completed || status == ScanStatus::Failed {
                Some(now)
            } else {
                None
            }).into(),
            (findings.len() as i64).into(),
        ],
    ).await?;

    // Insert findings.
    for finding in findings {
        sql_execute(
            &db,
            "INSERT OR REPLACE INTO findings (id, scan_id, severity, title, description, file_path, line_number, status, verified, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                finding.id.clone().into(),
                scan_id.into(),
                finding.severity.clone().into(),
                finding.title.clone().into(),
                finding.description.clone().unwrap_or_default().into(),
                finding.file_path.clone().unwrap_or_default().into(),
                finding.line_number.map(|n| n as i64).into(),
                finding.status.clone().into(),
                finding.verified.into(),
                finding.detected_at.clone().into(),
            ],
        ).await?;
    }

    Ok(())
}

/// List all scans from the local database.
pub async fn list_scans() -> Result<Vec<ScanSummary>, String> {
    let db = open_db().await?;
    let rows = sql_select(&db, "SELECT scan_id, target, mode, status, started_at, completed_at, finding_count FROM scans ORDER BY started_at DESC", &[]).await?;

    let mut summaries = Vec::new();
    for row in rows {
        let scan_id: String = get_string(&row, "scan_id")?;
        let target: String = get_string(&row, "target")?;
        let mode_str: String = get_string(&row, "mode")?;
        let status_str: String = get_string(&row, "status")?;
        let started_at: String = get_string(&row, "started_at")?;
        let completed_at: Option<String> = get_optional_string(&row, "completed_at")?;
        let finding_count: i64 = get_int(&row, "finding_count")?;

        let mode: ScanMode = serde_json::from_str(&mode_str).unwrap_or(ScanMode::Standard);
        let status: ScanStatus = serde_json::from_str(&status_str).unwrap_or(ScanStatus::Failed);

        summaries.push(ScanSummary {
            scan_id,
            target,
            mode,
            status,
            started_at,
            completed_at,
            finding_count: finding_count as usize,
        });
    }

    Ok(summaries)
}

/// Get a single scan with its findings.
pub async fn get_scan_detail(scan_id: &str) -> Result<ScanDetail, String> {
    let db = open_db().await?;

    let scan_rows = sql_select(&db, "SELECT scan_id, target, mode, status, started_at, completed_at, finding_count FROM scans WHERE scan_id = ?", &[scan_id.into()]).await?;

    let row = scan_rows.first().ok_or("scan not found")?;
    let target: String = get_string(row, "target")?;
    let mode_str: String = get_string(row, "mode")?;
    let status_str: String = get_string(row, "status")?;
    let started_at: String = get_string(row, "started_at")?;
    let completed_at: Option<String> = get_optional_string(row, "completed_at")?;
    let finding_count: i64 = get_int(row, "finding_count")?;

    let mode: ScanMode = serde_json::from_str(&mode_str).unwrap_or(ScanMode::Standard);
    let status: ScanStatus = serde_json::from_str(&status_str).unwrap_or(ScanStatus::Failed);

    let finding_rows = sql_select(&db, "SELECT id, severity, title, description, file_path, line_number, status, verified, detected_at FROM findings WHERE scan_id = ?", &[scan_id.into()]).await?;

    let mut findings = Vec::new();
    for frow in finding_rows {
        findings.push(Finding {
            id: get_string(&frow, "id")?,
            severity: get_string(&frow, "severity")?,
            title: get_string(&frow, "title")?,
            description: {
                let s = get_string(&frow, "description")?;
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            },
            file_path: {
                let s = get_string(&frow, "file_path")?;
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            },
            line_number: get_optional_int(&frow, "line_number")?.map(|n| n as u32),
            status: get_string(&frow, "status")?,
            verified: get_bool(&frow, "verified")?,
            detected_at: get_string(&frow, "detected_at")?,
        });
    }

    Ok(ScanDetail {
        scan_id: scan_id.to_string(),
        target,
        mode,
        status,
        started_at,
        completed_at,
        finding_count: finding_count as usize,
        findings,
    })
}

/// Export findings as SARIF 2.1.0 JSON.
pub fn export_sarif(findings: &[Finding], scan_id: &str) -> Result<String, String> {
    let results: Vec<serde_json::Value> = findings
        .iter()
        .map(|f| {
            let mut locations = Vec::new();
            if let Some(path) = &f.file_path {
                locations.push(serde_json::json!({
                    "physicalLocation": {
                        "artifactLocation": {
                            "uri": path
                        },
                        "region": f.line_number.map(|n| serde_json::json!({
                            "startLine": n
                        })).unwrap_or(serde_json::Value::Null)
                    }
                }));
            }

            serde_json::json!({
                "ruleId": f.title,
                "level": severity_to_sarif_level(&f.severity),
                "message": {
                    "text": f.description.as_deref().unwrap_or(&f.title)
                },
                "locations": locations,
                "partialFingerprints": {
                    "primaryLocationLineHash": f.id
                }
            })
        })
        .collect();

    let sarif = serde_json::json!({
        "$schema": "https://docs.oasis-open.org/sarif/sarif/v2.1.0/cs01/schemas/sarif-schema-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {
                "driver": {
                    "name": "LyraShield Local",
                    "version": env!("CARGO_PKG_VERSION"),
                    "informationUri": "https://lyrashieldai.com"
                }
            },
            "results": results,
            "automationDetails": {
                "guid": scan_id
            }
        }]
    });

    serde_json::to_string_pretty(&sarif).map_err(|e| format!("SARIF serialization failed: {}", e))
}

fn severity_to_sarif_level(severity: &str) -> &'static str {
    match severity.to_uppercase().as_str() {
        "CRITICAL" | "HIGH" => "error",
        "MEDIUM" => "warning",
        "LOW" | "INFO" => "note",
        _ => "none",
    }
}

// --- SQLite helper functions ---

async fn open_db() -> Result<Arc<tauri_plugin_sql::DbInstances>, String> {
    // The SQL plugin manages the connection pool. We access it via the app state.
    // For now, we use a simple file-based SQLite connection.
    Err("SQLite access requires Tauri app context — use commands.rs".into())
}

// Placeholder implementations — the actual SQL operations go through the
// Tauri SQL plugin's JavaScript API from the frontend, or through a Rust-side
// sqlx connection. For PR 2, we wire the frontend to use the SQL plugin
// directly for persistence, while the Rust side handles process spawning
// and event streaming.

async fn sql_execute(
    _db: &Arc<tauri_plugin_sql::DbInstances>,
    _sql: &str,
    _params: &[serde_json::Value],
) -> Result<(), String> {
    Ok(())
}

async fn sql_select(
    _db: &Arc<tauri_plugin_sql::DbInstances>,
    _sql: &str,
    _params: &[serde_json::Value],
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    Ok(Vec::new())
}

fn get_string(
    row: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<String, String> {
    row.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing field: {}", key))
}

fn get_optional_string(
    row: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Option<String>, String> {
    Ok(row.get(key).and_then(|v| v.as_str()).map(|s| s.to_string()))
}

fn get_int(row: &serde_json::Map<String, serde_json::Value>, key: &str) -> Result<i64, String> {
    row.get(key)
        .and_then(|v| v.as_i64())
        .ok_or_else(|| format!("missing field: {}", key))
}

fn get_optional_int(
    row: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Option<i64>, String> {
    Ok(row.get(key).and_then(|v| v.as_i64()))
}

fn get_bool(row: &serde_json::Map<String, serde_json::Value>, key: &str) -> Result<bool, String> {
    row.get(key)
        .and_then(|v| v.as_bool())
        .ok_or_else(|| format!("missing field: {}", key))
}
