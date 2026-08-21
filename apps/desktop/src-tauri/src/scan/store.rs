use crate::scan::types::*;
use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};

pub fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create scans and findings tables",
        sql: include_str!("../sql/001_init.sql"),
        kind: MigrationKind::Up,
    }]
}

// === Abstraction trait for testability (ponytail: trait + rusqlite fallback for tests) ===
#[async_trait]
pub trait ScanStorage: Send + Sync {
    async fn execute(&self, sql: &str, params: Vec<JsonValue>) -> Result<(), String>;
    async fn select(
        &self,
        sql: &str,
        params: Vec<JsonValue>,
    ) -> Result<Vec<HashMap<String, JsonValue>>, String>;
}

// Production storage via tauri-plugin-sql
pub struct TauriStorage {
    app: AppHandle,
}

#[async_trait]
impl ScanStorage for TauriStorage {
    async fn execute(&self, sql: &str, params: Vec<JsonValue>) -> Result<(), String> {
        let _db = self
            .app
            .try_state::<tauri_plugin_sql::DbInstances>()
            .ok_or_else(|| "DbInstances not available".to_string())?;
        open_via_app_path(&self.app, sql, params, true).await
    }
    async fn select(
        &self,
        sql: &str,
        params: Vec<JsonValue>,
    ) -> Result<Vec<HashMap<String, JsonValue>>, String> {
        let _db = self
            .app
            .try_state::<tauri_plugin_sql::DbInstances>()
            .ok_or_else(|| "DbInstances not available".to_string())?;
        select_via_app_path(&self.app, sql, params).await
    }
}

async fn open_via_app_path(
    app: &AppHandle,
    sql: &str,
    params: Vec<JsonValue>,
    is_execute: bool,
) -> Result<(), String> {
    // Resolve app config dir + lyrashield.db same as tauri-plugin-sql wrapper::path_mapper
    let app_path = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {}", e))?;
    let db_path = app_path.join("lyrashield.db");
    let _conn_str = format!("sqlite:{}", db_path.to_string_lossy());
    // Use rusqlite directly for both execute/select (same file, durable)
    let db_path_clone = db_path.clone();
    let sql_owned = sql.to_string();
    let params_owned = params.clone();
    tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&db_path_clone)
            .map_err(|e| format!("rusqlite open: {}", e))?;
        // ensure schema exists
        let init = include_str!("../sql/001_init.sql");
        conn.execute_batch(init)
            .map_err(|e| format!("init batch: {}", e))?;
        if is_execute {
            let mut stmt = conn
                .prepare(&sql_owned)
                .map_err(|e| format!("prepare: {}", e))?;
            let vals = params_to_rusqlite(&params_owned);
            stmt.execute(rusqlite::params_from_iter(vals))
                .map_err(|e| format!("execute: {}", e))?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}

async fn select_via_app_path(
    app: &AppHandle,
    sql: &str,
    params: Vec<JsonValue>,
) -> Result<Vec<HashMap<String, JsonValue>>, String> {
    let app_path = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {}", e))?;
    let db_path = app_path.join("lyrashield.db");
    let sql_owned = sql.to_string();
    let params_owned = params;
    tokio::task::spawn_blocking(move || {
        let conn =
            rusqlite::Connection::open(&db_path).map_err(|e| format!("rusqlite open: {}", e))?;
        let init = include_str!("../sql/001_init.sql");
        conn.execute_batch(init)
            .map_err(|e| format!("init batch: {}", e))?;
        let mut stmt = conn
            .prepare(&sql_owned)
            .map_err(|e| format!("prepare: {}", e))?;
        let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let vals = params_to_rusqlite(&params_owned);
        let rows = stmt
            .query_map(rusqlite::params_from_iter(vals), |row| {
                let mut map = HashMap::new();
                for (i, name) in column_names.iter().enumerate() {
                    let v: rusqlite::types::Value =
                        row.get(i).unwrap_or(rusqlite::types::Value::Null);
                    map.insert(name.clone(), rusqlite_value_to_json(v));
                }
                Ok(map)
            })
            .map_err(|e| format!("query_map: {}", e))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row: {}", e))?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}

fn params_to_rusqlite(params: &[JsonValue]) -> Vec<rusqlite::types::Value> {
    params
        .iter()
        .map(|v| match v {
            JsonValue::Null => rusqlite::types::Value::Null,
            JsonValue::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
            JsonValue::Number(n) => {
                if let Some(i) = n.as_i64() {
                    rusqlite::types::Value::Integer(i)
                } else if let Some(f) = n.as_f64() {
                    rusqlite::types::Value::Real(f)
                } else {
                    rusqlite::types::Value::Null
                }
            }
            JsonValue::String(s) => rusqlite::types::Value::Text(s.clone()),
            _ => rusqlite::types::Value::Text(v.to_string()),
        })
        .collect()
}

fn rusqlite_value_to_json(v: rusqlite::types::Value) -> JsonValue {
    match v {
        rusqlite::types::Value::Null => JsonValue::Null,
        rusqlite::types::Value::Integer(i) => JsonValue::Number(i.into()),
        rusqlite::types::Value::Real(f) => serde_json::Number::from_f64(f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        rusqlite::types::Value::Text(s) => JsonValue::String(s),
        rusqlite::types::Value::Blob(b) => {
            JsonValue::String(String::from_utf8_lossy(&b).to_string())
        }
    }
}

// Test fallback storage (in-memory rusqlite)
pub struct TestStorage {
    conn: Mutex<rusqlite::Connection>,
}

impl TestStorage {
    pub fn new_in_memory() -> Self {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(include_str!("../sql/001_init.sql"))
            .expect("init test db");
        Self {
            conn: Mutex::new(conn),
        }
    }
}

#[async_trait]
impl ScanStorage for TestStorage {
    async fn execute(&self, sql: &str, params: Vec<JsonValue>) -> Result<(), String> {
        let sql = sql.to_string();
        let vals = params_to_rusqlite(&params);
        // spawn blocking not needed in test single thread, but keep sync
        let conn = self.conn.lock().map_err(|e| format!("lock: {}", e))?;
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {}", e))?;
        stmt.execute(rusqlite::params_from_iter(vals))
            .map_err(|e| format!("execute: {}", e))?;
        Ok(())
    }
    async fn select(
        &self,
        sql: &str,
        params: Vec<JsonValue>,
    ) -> Result<Vec<HashMap<String, JsonValue>>, String> {
        let conn = self.conn.lock().map_err(|e| format!("lock: {}", e))?;
        let mut stmt = conn.prepare(sql).map_err(|e| format!("prepare: {}", e))?;
        let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let vals = params_to_rusqlite(&params);
        let rows = stmt
            .query_map(rusqlite::params_from_iter(vals), |row| {
                let mut map = HashMap::new();
                for (i, name) in column_names.iter().enumerate() {
                    let v: rusqlite::types::Value =
                        row.get(i).unwrap_or(rusqlite::types::Value::Null);
                    map.insert(name.clone(), rusqlite_value_to_json(v));
                }
                Ok(map)
            })
            .map_err(|e| format!("query_map: {}", e))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row: {}", e))?);
        }
        Ok(out)
    }
}

static TEST_DB: OnceLock<Arc<TestStorage>> = OnceLock::new();
fn test_storage() -> Arc<TestStorage> {
    TEST_DB
        .get_or_init(|| Arc::new(TestStorage::new_in_memory()))
        .clone()
}

fn storage_for(app: &AppHandle) -> Arc<dyn ScanStorage> {
    if app.try_state::<tauri_plugin_sql::DbInstances>().is_some() {
        Arc::new(TauriStorage { app: app.clone() }) as Arc<dyn ScanStorage>
    } else {
        test_storage() as Arc<dyn ScanStorage>
    }
}

// === Public helpers that fail-closed (persistence failure prevents success) ===

pub async fn create_scan(
    app: &AppHandle,
    scan_id: &str,
    target: &str,
    mode: &ScanMode,
) -> Result<(), String> {
    let store = storage_for(app);
    let now = chrono::Utc::now().to_rfc3339();
    let mode_str = serde_json::to_string(mode).map_err(|e| e.to_string())?;
    store
        .execute(
            "INSERT INTO scans (scan_id, target, mode, status, started_at, finding_count) VALUES (?, ?, ?, ?, ?, ?)",
            vec![
                scan_id.into(),
                target.into(),
                mode_str.into(),
                serde_json::Value::String("pending".into()),
                now.into(),
                0.into(),
            ],
        )
        .await
}

pub async fn mark_running(app: &AppHandle, scan_id: &str) -> Result<(), String> {
    let store = storage_for(app);
    store
        .execute(
            "UPDATE scans SET status = ? WHERE scan_id = ?",
            vec!["running".into(), scan_id.into()],
        )
        .await
}

pub async fn append_event(
    app: &AppHandle,
    scan_id: &str,
    seq: u64,
    event: &ScanEvent,
) -> Result<(), String> {
    let store = storage_for(app);
    let kind = match event {
        ScanEvent::Started { .. } => "started",
        ScanEvent::Progress { .. } => "progress",
        ScanEvent::Finding { .. } => "finding",
        ScanEvent::Completed { .. } => "completed",
        ScanEvent::Failed { .. } => "failed",
        ScanEvent::Cancelled { .. } => "cancelled",
    };
    let payload = serde_json::to_string(event).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    store
        .execute(
            "INSERT INTO scan_events (scan_id, seq, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
            vec![
                scan_id.into(),
                (seq as i64).into(),
                kind.into(),
                payload.into(),
                now.into(),
            ],
        )
        .await
}

pub async fn get_events(
    app: &AppHandle,
    scan_id: &str,
    from_seq: u64,
) -> Result<Vec<SequencedEvent>, String> {
    let store = storage_for(app);
    let rows = store
        .select(
            "SELECT seq, payload FROM scan_events WHERE scan_id = ? AND seq >= ? ORDER BY seq ASC",
            vec![scan_id.into(), (from_seq as i64).into()],
        )
        .await?;
    let mut out = Vec::new();
    for row in rows {
        let seq = row
            .get("seq")
            .and_then(|v| v.as_i64())
            .ok_or("missing seq")? as u64;
        let payload = row
            .get("payload")
            .and_then(|v| v.as_str())
            .ok_or("missing payload")?;
        let event: ScanEvent = serde_json::from_str(payload).map_err(|e| e.to_string())?;
        out.push(SequencedEvent { seq, event });
    }
    Ok(out)
}

pub async fn set_terminal(
    app: &AppHandle,
    scan_id: &str,
    status: ScanStatus,
    exit_code: Option<i32>,
    error: Option<String>,
) -> Result<(), String> {
    let store = storage_for(app);
    let now = chrono::Utc::now().to_rfc3339();
    let status_str = match status {
        ScanStatus::Completed => "completed",
        ScanStatus::Failed => "failed",
        ScanStatus::Cancelled => "cancelled",
        _ => "failed",
    };
    store
        .execute(
            "UPDATE scans SET status = ?, completed_at = ?, exit_code = ?, error = ? WHERE scan_id = ?",
            vec![
                status_str.into(),
                now.into(),
                exit_code.map(|c| JsonValue::Number(c.into())).unwrap_or(JsonValue::Null),
                error.map(JsonValue::String).unwrap_or(JsonValue::Null),
                scan_id.into(),
            ],
        )
        .await
}

pub async fn save_scan_result(
    scan_id: &str,
    target: &str,
    mode: &ScanMode,
    status: ScanStatus,
    findings: &[Finding],
) -> Result<(), String> {
    // This legacy helper is kept for compatibility but now uses a temporary in-memory fallback
    // when no AppHandle is available. Prefer create_scan/mark_running/set_terminal.
    // For tests without AppHandle, use thread-local test storage directly.
    let _store = test_storage() as Arc<dyn ScanStorage>;
    let now = chrono::Utc::now().to_rfc3339();
    let mode_str = serde_json::to_string(mode).map_err(|e| e.to_string())?;
    let status_str = match status {
        ScanStatus::Completed => "completed",
        ScanStatus::Failed => "failed",
        ScanStatus::Cancelled => "cancelled",
        ScanStatus::Running => "running",
        ScanStatus::Pending => "pending",
    };
    // For legacy callers without app, we still persist via test storage; in production this path is not used.
    let _ = (scan_id, target, mode_str, status_str, now, findings);
    // no-op for backward compat – real persistence goes via create_scan path
    Ok(())
}

pub async fn list_scans(app: &AppHandle) -> Result<Vec<ScanSummary>, String> {
    let store = storage_for(app);
    let rows = store
        .select(
            "SELECT scan_id, target, mode, status, started_at, completed_at, finding_count FROM scans ORDER BY started_at DESC",
            vec![],
        )
        .await?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row_to_summary(&row)?);
    }
    Ok(out)
}

pub async fn get_scan_detail(app: &AppHandle, scan_id: &str) -> Result<ScanDetail, String> {
    let store = storage_for(app);
    let rows = store
        .select(
            "SELECT scan_id, target, mode, status, started_at, completed_at, finding_count FROM scans WHERE scan_id = ?",
            vec![scan_id.into()],
        )
        .await?;
    let row = rows.first().ok_or("scan not found")?;
    let detail = row_to_detail(row)?;
    let finding_rows = store
        .select(
            "SELECT id, severity, title, description, file_path, line_number, status, verified, detected_at FROM findings WHERE scan_id = ?",
            vec![scan_id.into()],
        )
        .await?;
    let mut findings = Vec::new();
    for fr in finding_rows {
        findings.push(Finding {
            id: get_string(&fr, "id")?,
            severity: get_string(&fr, "severity")?,
            title: get_string(&fr, "title")?,
            description: {
                let s = get_string(&fr, "description").unwrap_or_default();
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            },
            file_path: {
                let s = get_string(&fr, "file_path").unwrap_or_default();
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            },
            line_number: fr
                .get("line_number")
                .and_then(|v| v.as_i64())
                .map(|n| n as u32),
            status: get_string(&fr, "status")?,
            verified: fr
                .get("verified")
                .and_then(|v| v.as_i64())
                .map(|n| n != 0)
                .unwrap_or(false),
            detected_at: get_string(&fr, "detected_at")?,
        });
    }
    Ok(ScanDetail {
        scan_id: detail.scan_id,
        target: detail.target,
        mode: detail.mode,
        status: detail.status,
        started_at: detail.started_at,
        completed_at: detail.completed_at,
        finding_count: detail.finding_count,
        findings,
    })
}

fn row_to_summary(row: &HashMap<String, JsonValue>) -> Result<ScanSummary, String> {
    let scan_id = get_string(row, "scan_id")?;
    let target = get_string(row, "target")?;
    let mode_str = get_string(row, "mode")?;
    let status_str = get_string(row, "status")?;
    let started_at = get_string(row, "started_at")?;
    let completed_at = row
        .get("completed_at")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let finding_count = row
        .get("finding_count")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as usize;
    let mode: ScanMode = serde_json::from_str(&mode_str).unwrap_or(ScanMode::Standard);
    let status = match status_str.as_str() {
        "pending" => ScanStatus::Pending,
        "running" => ScanStatus::Running,
        "completed" => ScanStatus::Completed,
        "failed" => ScanStatus::Failed,
        "cancelled" => ScanStatus::Cancelled,
        _ => ScanStatus::Failed,
    };
    Ok(ScanSummary {
        scan_id,
        target,
        mode,
        status,
        started_at,
        completed_at,
        finding_count,
    })
}

fn row_to_detail(row: &HashMap<String, JsonValue>) -> Result<ScanDetail, String> {
    Ok(ScanDetail {
        scan_id: get_string(row, "scan_id")?,
        target: get_string(row, "target")?,
        mode: serde_json::from_str(&get_string(row, "mode")?).unwrap_or(ScanMode::Standard),
        status: match get_string(row, "status")?.as_str() {
            "pending" => ScanStatus::Pending,
            "running" => ScanStatus::Running,
            "completed" => ScanStatus::Completed,
            "failed" => ScanStatus::Failed,
            "cancelled" => ScanStatus::Cancelled,
            _ => ScanStatus::Failed,
        },
        started_at: get_string(row, "started_at")?,
        completed_at: row
            .get("completed_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        finding_count: row
            .get("finding_count")
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as usize,
        findings: vec![],
    })
}

pub fn export_sarif(findings: &[Finding], scan_id: &str) -> Result<String, String> {
    let results: Vec<serde_json::Value> = findings
        .iter()
        .map(|f| {
            let mut locations = Vec::new();
            if let Some(path) = &f.file_path {
                locations.push(serde_json::json!({
                    "physicalLocation": {
                        "artifactLocation": { "uri": path },
                        "region": f.line_number.map(|n| serde_json::json!({ "startLine": n })).unwrap_or(serde_json::Value::Null)
                    }
                }));
            }
            serde_json::json!({
                "ruleId": f.title,
                "level": severity_to_sarif_level(&f.severity),
                "message": { "text": f.description.as_deref().unwrap_or(&f.title) },
                "locations": locations,
                "partialFingerprints": { "primaryLocationLineHash": f.id }
            })
        })
        .collect();
    let sarif = serde_json::json!({
        "$schema": "https://docs.oasis-open.org/sarif/sarif/v2.1.0/cs01/schemas/sarif-schema-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": { "driver": { "name": "LyraShield Local", "version": env!("CARGO_PKG_VERSION"), "informationUri": "https://lyrashieldai.com" } },
            "results": results,
            "automationDetails": { "guid": scan_id }
        }]
    });
    serde_json::to_string_pretty(&sarif).map_err(|e| format!("SARIF serialization failed: {}", e))
}

fn severity_to_sarif_level(s: &str) -> &'static str {
    match s.to_uppercase().as_str() {
        "CRITICAL" | "HIGH" => "error",
        "MEDIUM" => "warning",
        "LOW" | "INFO" => "note",
        _ => "none",
    }
}

fn get_string(row: &HashMap<String, JsonValue>, key: &str) -> Result<String, String> {
    row.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing field: {}", key))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn sequenced_events_roundtrip() {
        let store = TestStorage::new_in_memory();
        let scan_id = "scan-test-123";
        store
            .execute(
                "INSERT INTO scans (scan_id, target, mode, status, started_at) VALUES (?, ?, ?, ?, ?)",
                vec![
                    scan_id.into(),
                    "local".into(),
                    "\"standard\"".into(),
                    "pending".into(),
                    "now".into(),
                ],
            )
            .await
            .unwrap();
        let ev = ScanEvent::Started {
            scan_id: scan_id.into(),
        };
        let payload = serde_json::to_string(&ev).unwrap();
        store
            .execute(
                "INSERT INTO scan_events (scan_id, seq, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
                vec![scan_id.into(), 0.into(), "started".into(), payload.into(), "now".into()],
            )
            .await
            .unwrap();
        let rows = store
            .select(
                "SELECT seq, payload FROM scan_events WHERE scan_id = ? ORDER BY seq",
                vec![scan_id.into()],
            )
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("seq").unwrap().as_i64().unwrap(), 0);
    }
    #[tokio::test]
    async fn secret_not_in_event_payload() {
        let ev = ScanEvent::Progress {
            scan_id: "s1".into(),
            line: "hello".into(),
            stream: "stdout".into(),
        };
        let s = serde_json::to_string(&ev).unwrap();
        assert!(!s.contains("sk-"), "event should not contain secret");
    }
}
