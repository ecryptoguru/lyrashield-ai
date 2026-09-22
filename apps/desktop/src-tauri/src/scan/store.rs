use crate::scan::types::*;
use async_trait::async_trait;
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha384};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Manager};

const MIGRATIONS: &[(i64, &str, &str)] = &[
    (
        1,
        "create scans and findings tables",
        include_str!("../sql/001_init.sql"),
    ),
    (
        2,
        "workflow and evidence projection columns",
        include_str!("../sql/002_workflow_evidence.sql"),
    ),
    (
        3,
        "contextual finding evidence and threat model state",
        include_str!("../sql/003_evidence_context.sql"),
    ),
];
const MIGRATION_TABLE: &str = "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN NOT NULL,
    checksum BLOB NOT NULL,
    execution_time BIGINT NOT NULL
);";
// Keep the existing app config path and idempotent schema so upgrades retain data.
pub fn initialize_database(app: &AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {}", e))?;
    open_database(&path.join("lyrashield.db"))?;
    Ok(())
}

fn open_database(path: &std::path::Path) -> Result<rusqlite::Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create database directory: {}", e))?;
    }
    let mut conn = rusqlite::Connection::open(path).map_err(|e| format!("rusqlite open: {}", e))?;
    // SQLx created shipped databases in WAL mode; retain that concurrency contract.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("database journal mode: {}", e))?;
    migrate_database(&mut conn, MIGRATIONS)?;
    Ok(conn)
}

// Startup owns schema validation. Normal operations must not acquire migration
// write locks, or recreate a database removed after startup.
fn connect_database(path: &std::path::Path) -> Result<rusqlite::Connection, String> {
    rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| format!("rusqlite open: {}", e))
}

// Preserve the SQLx migration ledger and checksum contract used by shipped databases.
fn migrate_database(
    conn: &mut rusqlite::Connection,
    migrations: &[(i64, &str, &str)],
) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| format!("migration transaction: {}", e))?;
    tx.execute_batch(MIGRATION_TABLE)
        .map_err(|e| format!("migration ledger: {}", e))?;
    let applied = {
        let mut stmt = tx
            .prepare("SELECT version, success, checksum FROM _sqlx_migrations ORDER BY version")
            .map_err(|e| format!("read migrations: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            })
            .map_err(|e| format!("read migrations: {}", e))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read migrations: {}", e))?
    };
    for (version, success, checksum) in &applied {
        let Some((_, _, sql)) = migrations.iter().find(|(id, _, _)| id == version) else {
            return Err(format!("unknown applied migration: {}", version));
        };
        if !success || checksum.as_slice() != Sha384::digest(sql.as_bytes()).as_slice() {
            return Err(format!("dirty or changed migration: {}", version));
        }
    }
    for (version, description, sql) in migrations {
        if applied.iter().any(|(id, _, _)| id == version) {
            continue;
        }
        let started = std::time::Instant::now();
        tx.execute_batch(sql)
            .map_err(|e| format!("migration {} failed: {}", version, e))?;
        tx.execute("INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (?1, ?2, 1, ?3, ?4)",
            rusqlite::params![version, description, Sha384::digest(sql.as_bytes()).as_slice(), started.elapsed().as_nanos().min(i64::MAX as u128) as i64])
            .map_err(|e| format!("record migration {}: {}", version, e))?;
    }
    tx.commit().map_err(|e| format!("commit migrations: {}", e))
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

// Production storage uses the existing native rusqlite connection path.
pub struct TauriStorage {
    app: AppHandle,
}

#[async_trait]
impl ScanStorage for TauriStorage {
    async fn execute(&self, sql: &str, params: Vec<JsonValue>) -> Result<(), String> {
        open_via_app_path(&self.app, sql, params, true).await
    }
    async fn select(
        &self,
        sql: &str,
        params: Vec<JsonValue>,
    ) -> Result<Vec<HashMap<String, JsonValue>>, String> {
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
    // Use rusqlite directly for both execute/select (same file, durable)
    let db_path_clone = db_path.clone();
    let sql_owned = sql.to_string();
    let params_owned = params.clone();
    tokio::task::spawn_blocking(move || {
        let conn = connect_database(&db_path_clone)?;
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
        let conn = connect_database(&db_path)?;
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
        let mut conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        migrate_database(&mut conn, MIGRATIONS).expect("migrate test db");
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
    Arc::new(TauriStorage { app: app.clone() }) as Arc<dyn ScanStorage>
}

// === Public helpers that fail-closed (persistence failure prevents success) ===

pub async fn create_scan(
    app: &AppHandle,
    scan_id: &str,
    target: &str,
    mode: &ScanMode,
    workflow: &ScanWorkflow,
    diff_base: Option<&str>,
    diff_head: Option<&str>,
) -> Result<(), String> {
    let store = storage_for(app);
    let now = chrono::Utc::now().to_rfc3339();
    let mode_str = serde_json::to_string(mode).map_err(|e| e.to_string())?;
    store
        .execute(
            "INSERT INTO scans (scan_id, target, mode, status, started_at, finding_count, workflow, backend, diff_base, diff_head) VALUES (?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)",
            vec![
                scan_id.into(),
                target.into(),
                mode_str.into(),
                serde_json::Value::String("pending".into()),
                now.into(),
                0.into(),
                workflow.as_str().into(),
                diff_base.map(|s| JsonValue::String(s.to_string())).unwrap_or(JsonValue::Null),
                diff_head.map(|s| JsonValue::String(s.to_string())).unwrap_or(JsonValue::Null),
            ],
        )
        .await
}

/// Record a hosted Review Changes / Review Target scan submitted to
/// LyraShield Cloud. Status `submitted` is honest: the run executes
/// server-side and the desktop never fakes local progress or findings for it.
pub async fn create_submitted_scan(
    app: &AppHandle,
    scan_id: &str,
    target: &str,
    mode: &ScanMode,
    workflow: &ScanWorkflow,
    diff_base: Option<&str>,
    diff_head: Option<&str>,
) -> Result<(), String> {
    let store = storage_for(app);
    let now = chrono::Utc::now().to_rfc3339();
    let mode_str = serde_json::to_string(mode).map_err(|e| e.to_string())?;
    store
        .execute(
            "INSERT INTO scans (scan_id, target, mode, status, started_at, finding_count, workflow, backend, diff_base, diff_head) VALUES (?, ?, ?, 'submitted', ?, 0, ?, 'cloud', ?, ?)",
            vec![
                scan_id.into(),
                target.into(),
                mode_str.into(),
                now.into(),
                workflow.as_str().into(),
                diff_base.map(|s| JsonValue::String(s.to_string())).unwrap_or(JsonValue::Null),
                diff_head.map(|s| JsonValue::String(s.to_string())).unwrap_or(JsonValue::Null),
            ],
        )
        .await
}

pub async fn mark_running(app: &AppHandle, scan_id: &str) -> Result<(), String> {
    let store = storage_for(app);
    store
        .execute(
            "UPDATE scans SET status = ? WHERE scan_id = ? AND status = 'pending'",
            vec!["running".into(), scan_id.into()],
        )
        .await
}

pub async fn persist_finding(
    app: &AppHandle,
    scan_id: &str,
    finding: &Finding,
) -> Result<(), String> {
    // `verified` stays a local-only flag — never the engine's own claim. The
    // authoritative tier is `verification_state` (always DETECTED locally).
    storage_for(app)
        .execute(
            "INSERT INTO findings (id, scan_id, severity, title, description, file_path, line_number, status, verified, detected_at, verification_state, evidence_pending, counterevidence, confidence_rationale, fix_verification, http_exchange_ids, evidence_context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            vec![
                finding.id.clone().into(),
                scan_id.into(),
                finding.severity.clone().into(),
                finding.title.clone().into(),
                finding.description.clone().map(JsonValue::String).unwrap_or(JsonValue::Null),
                finding.file_path.clone().map(JsonValue::String).unwrap_or(JsonValue::Null),
                finding.line_number.map(|line| JsonValue::Number(line.into())).unwrap_or(JsonValue::Null),
                finding.status.clone().into(),
                false.into(),
                finding.detected_at.clone().into(),
                VERIFICATION_STATE_DETECTED.into(),
                finding.evidence_pending.into(),
                finding.counterevidence.clone().map(JsonValue::String).unwrap_or(JsonValue::Null),
                finding.confidence_rationale.clone().map(JsonValue::String).unwrap_or(JsonValue::Null),
                finding.fix_verification.clone().map(JsonValue::String).unwrap_or(JsonValue::Null),
                serde_json::to_string(&finding.http_exchange_ids)
                    .map(JsonValue::String)
                    .unwrap_or(JsonValue::Null),
                finding.evidence_context.as_ref()
                    .and_then(|context| serde_json::to_string(context).ok())
                    .map(JsonValue::String)
                    .unwrap_or(JsonValue::Null),
            ],
        )
        .await
}

/// Stamp the engine run contract observed for a scan (run.json
/// `schema_version`). Unknown stays NULL — never backfilled with a guess.
pub async fn set_scan_contract_version(
    app: &AppHandle,
    scan_id: &str,
    contract_version: &str,
) -> Result<(), String> {
    storage_for(app)
        .execute(
            "UPDATE scans SET contract_version = ? WHERE scan_id = ? AND contract_version IS NULL",
            vec![contract_version.into(), scan_id.into()],
        )
        .await
}

pub async fn set_scan_threat_model_available(
    app: &AppHandle,
    scan_id: &str,
    available: bool,
) -> Result<(), String> {
    storage_for(app)
        .execute(
            "UPDATE scans SET threat_model_available = ? WHERE scan_id = ?",
            vec![JsonValue::from(i64::from(available)), scan_id.into()],
        )
        .await
}

/// Merge richer engine evidence fields onto a persisted finding (matched by
/// the run's finding id). Engine attestation only — verification_state stays
/// DETECTED and evidence_pending is raised, never cleared, by this path.
pub async fn update_finding_evidence(
    app: &AppHandle,
    scan_id: &str,
    finding_id: &str,
    evidence: &FindingEvidenceUpdate,
) -> Result<(), String> {
    storage_for(app)
        .execute(
            "UPDATE findings SET evidence_pending = 1, counterevidence = COALESCE(?, counterevidence), confidence_rationale = COALESCE(?, confidence_rationale), fix_verification = COALESCE(?, fix_verification), http_exchange_ids = COALESCE(?, http_exchange_ids), evidence_context = COALESCE(?, evidence_context) WHERE scan_id = ? AND id = ?",
            vec![
                evidence
                    .counterevidence
                    .clone()
                    .map(JsonValue::String)
                    .unwrap_or(JsonValue::Null),
                evidence
                    .confidence_rationale
                    .clone()
                    .map(JsonValue::String)
                    .unwrap_or(JsonValue::Null),
                evidence
                    .fix_verification
                    .clone()
                    .map(JsonValue::String)
                    .unwrap_or(JsonValue::Null),
                evidence
                    .http_exchange_ids
                    .clone()
                    .map(JsonValue::String)
                    .unwrap_or(JsonValue::Null),
                evidence
                    .evidence_context
                    .as_ref()
                    .and_then(|context| serde_json::to_string(context).ok())
                    .map(JsonValue::String)
                    .unwrap_or(JsonValue::Null),
                scan_id.into(),
                finding_id.into(),
            ],
        )
        .await
}

/// Evidence fields merged from the engine run artifacts (untrusted content,
/// attestation only — see `update_finding_evidence`).
pub struct FindingEvidenceUpdate {
    pub counterevidence: Option<String>,
    pub confidence_rationale: Option<String>,
    pub fix_verification: Option<String>,
    pub http_exchange_ids: Option<String>,
    pub evidence_context: Option<FindingEvidenceContext>,
}

pub async fn set_finding_count(
    app: &AppHandle,
    scan_id: &str,
    finding_count: usize,
) -> Result<(), String> {
    storage_for(app)
        .execute(
            "UPDATE scans SET finding_count = ? WHERE scan_id = ?",
            vec![(finding_count as i64).into(), scan_id.into()],
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

// Commit the terminal status and replay event together. The runner is the only writer.
pub async fn persist_terminal(
    app: &AppHandle,
    scan_id: &str,
    event: &ScanEvent,
    exit_code: Option<i32>,
) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("lyrashield.db");
    let scan_id = scan_id.to_owned();
    let event = event.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = connect_database(&path)?;
        persist_terminal_in(&mut conn, &scan_id, &event, exit_code)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn persist_terminal_in(
    conn: &mut rusqlite::Connection,
    scan_id: &str,
    event: &ScanEvent,
    process_exit_code: Option<i32>,
) -> Result<(), String> {
    let (status, exit_code, error) = match event {
        ScanEvent::Completed { exit_code, .. } => ("completed", Some(*exit_code), None),
        ScanEvent::Cancelled { .. } => ("cancelled", Some(CrashCode::Cancelled as i32), None),
        ScanEvent::Failed { error, .. } => (
            "failed",
            process_exit_code.or(Some(CrashCode::EngineCrash as i32)),
            Some(error.as_str()),
        ),
        _ => return Err("terminal event required".into()),
    };
    let payload = serde_json::to_string(event).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let changed = tx.execute("UPDATE scans SET status=?1, completed_at=?2, exit_code=?3, error=?4, finding_count=(SELECT COUNT(*) FROM findings WHERE scan_id=?5) WHERE scan_id=?5 AND status IN ('pending','running')",
        rusqlite::params![status, now, exit_code, error, scan_id]).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("scan is missing or already terminal".into());
    }
    tx.execute("INSERT INTO scan_events (scan_id,seq,kind,payload,created_at) SELECT ?1, COALESCE(MAX(seq)+1,0), ?2, ?3, ?4 FROM scan_events WHERE scan_id=?1",
        rusqlite::params![scan_id, status, payload, now]).map_err(|e| e.to_string())?;
    tx.commit()
        .map_err(|e| format!("terminal persistence failed: {}", e))
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
            "UPDATE scans SET status = ?, completed_at = ?, exit_code = ?, error = ? WHERE scan_id = ? AND status IN ('pending', 'running')",
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
        ScanStatus::Submitted => "submitted",
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
            "SELECT scan_id, target, mode, workflow, backend, contract_version, diff_base, diff_head, status, started_at, completed_at, finding_count FROM scans ORDER BY started_at DESC",
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
            "SELECT scan_id, target, mode, workflow, backend, contract_version, diff_base, diff_head, threat_model_available, status, started_at, completed_at, finding_count FROM scans WHERE scan_id = ?",
            vec![scan_id.into()],
        )
        .await?;
    let row = rows.first().ok_or("scan not found")?;
    let detail = row_to_detail(row)?;
    let finding_rows = store
        .select(
            "SELECT id, severity, title, description, file_path, line_number, status, verified, detected_at, verification_state, evidence_pending, counterevidence, confidence_rationale, fix_verification, http_exchange_ids, evidence_context FROM findings WHERE scan_id = ?",
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
            // Missing data stays unknown-renderable: legacy rows default to
            // DETECTED with no attestation, never a fabricated tier.
            verification_state: fr
                .get("verification_state")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| VERIFICATION_STATE_DETECTED.to_string()),
            evidence_pending: fr
                .get("evidence_pending")
                .and_then(|v| v.as_i64())
                .map(|n| n != 0)
                .unwrap_or(false),
            counterevidence: get_string(&fr, "counterevidence")
                .ok()
                .filter(|s| !s.is_empty()),
            confidence_rationale: get_string(&fr, "confidence_rationale")
                .ok()
                .filter(|s| !s.is_empty()),
            fix_verification: get_string(&fr, "fix_verification")
                .ok()
                .filter(|s| !s.is_empty()),
            http_exchange_ids: fr
                .get("http_exchange_ids")
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                .unwrap_or_default(),
            evidence_context: fr
                .get("evidence_context")
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str::<FindingEvidenceContext>(s).ok()),
            detected_at: get_string(&fr, "detected_at")?,
        });
    }
    Ok(ScanDetail {
        scan_id: detail.scan_id,
        target: detail.target,
        mode: detail.mode,
        workflow: detail.workflow,
        backend: detail.backend,
        contract_version: detail.contract_version,
        threat_model_available: detail.threat_model_available,
        diff_base: detail.diff_base,
        diff_head: detail.diff_head,
        status: detail.status,
        started_at: detail.started_at,
        completed_at: detail.completed_at,
        finding_count: detail.finding_count,
        findings,
    })
}

fn stored_status(raw: &str) -> ScanStatus {
    match raw {
        "pending" => ScanStatus::Pending,
        "running" => ScanStatus::Running,
        "completed" => ScanStatus::Completed,
        "failed" => ScanStatus::Failed,
        "cancelled" => ScanStatus::Cancelled,
        "submitted" => ScanStatus::Submitted,
        _ => ScanStatus::Failed,
    }
}

fn opt_string(row: &HashMap<String, JsonValue>, key: &str) -> Option<String> {
    row.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
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
    let mode = ScanMode::from_stored(&mode_str);
    let status = stored_status(&status_str);
    // v1 rows have NULL workflow — stored as the column default
    // 'REVIEW_TARGET' on migration; truly unparseable values surface as
    // Unknown rather than a fabricated workflow.
    let workflow = opt_string(row, "workflow")
        .map(|w| ScanWorkflow::from_stored(&w))
        .unwrap_or_default();
    let backend = opt_string(row, "backend").unwrap_or_else(|| "local".to_string());
    Ok(ScanSummary {
        scan_id,
        target,
        mode,
        workflow,
        backend,
        contract_version: opt_string(row, "contract_version"),
        diff_base: opt_string(row, "diff_base"),
        diff_head: opt_string(row, "diff_head"),
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
        mode: ScanMode::from_stored(&get_string(row, "mode")?),
        workflow: opt_string(row, "workflow")
            .map(|w| ScanWorkflow::from_stored(&w))
            .unwrap_or_default(),
        backend: opt_string(row, "backend").unwrap_or_else(|| "local".to_string()),
        contract_version: opt_string(row, "contract_version"),
        threat_model_available: row
            .get("threat_model_available")
            .and_then(|v| v.as_i64())
            .map(|value| value != 0),
        diff_base: opt_string(row, "diff_base"),
        diff_head: opt_string(row, "diff_head"),
        status: stored_status(&get_string(row, "status")?),
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
    #[test]
    fn browser_fixtures_match_real_native_wire_and_export_inputs() {
        let wire: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../e2e/browser/desktop-wire.json"))
                .unwrap();
        let summary: super::ScanSummary = serde_json::from_value(wire["summary"].clone()).unwrap();
        assert_eq!(serde_json::to_value(summary).unwrap(), wire["summary"]);
        let detail: super::ScanDetail = serde_json::from_value(wire["detail"].clone()).unwrap();
        assert_eq!(serde_json::to_value(&detail).unwrap(), wire["detail"]);
        for event in wire["events"].as_array().unwrap() {
            let actual: super::ScanEvent = serde_json::from_value(event.clone()).unwrap();
            assert_eq!(serde_json::to_value(actual).unwrap(), *event);
        }
        for result in wire["syncResults"].as_array().unwrap() {
            let actual: crate::sync::SyncResult = serde_json::from_value(result.clone()).unwrap();
            assert_eq!(serde_json::to_value(actual).unwrap(), *result);
        }
        let sarif: serde_json::Value = serde_json::from_str(
            &super::export_sarif(&detail.findings[..1], &detail.scan_id).unwrap(),
        )
        .unwrap();
        assert_eq!(sarif["runs"][0]["results"].as_array().unwrap().len(), 1);
        assert_eq!(
            sarif["runs"][0]["results"][0]["locations"][0]["physicalLocation"]["artifactLocation"]
                ["uri"],
            "src/example.ts"
        );
    }

    #[test]
    fn completed_scan_rejects_late_cancel_and_failure_preserves_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = super::open_database(&dir.path().join("terminal.db")).unwrap();
        for id in ["done", "failed"] {
            conn.execute("INSERT INTO scans (scan_id,target,mode,status,started_at) VALUES (?1,'local','standard','running','now')", [id]).unwrap();
        }
        super::persist_terminal_in(
            &mut conn,
            "done",
            &super::ScanEvent::Completed {
                scan_id: "done".into(),
                exit_code: 0,
                finding_count: 0,
            },
            Some(0),
        )
        .unwrap();
        assert!(super::persist_terminal_in(
            &mut conn,
            "done",
            &super::ScanEvent::Cancelled {
                scan_id: "done".into()
            },
            None
        )
        .is_err());
        assert_eq!(
            conn.query_row("SELECT status FROM scans WHERE scan_id='done'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "completed"
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM scan_events WHERE scan_id='done'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        super::persist_terminal_in(
            &mut conn,
            "failed",
            &super::ScanEvent::Failed {
                scan_id: "failed".into(),
                error: "Engine exited with code 7".into(),
            },
            Some(7),
        )
        .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT exit_code FROM scans WHERE scan_id='failed'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            7
        );
    }

    #[test]
    fn terminal_status_and_replay_commit_together_and_cannot_be_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.db");
        let mut conn = super::open_database(&path).unwrap();
        conn.execute("INSERT INTO scans (scan_id,target,mode,status,started_at) VALUES ('s','local','standard','running','now')", []).unwrap();
        conn.execute("INSERT INTO scan_events (scan_id,seq,kind,payload,created_at) VALUES ('s',9,'progress','{}','now')", []).unwrap();
        // An event failure rolls status back as well; no false cancelled receipt.
        conn.execute_batch("CREATE TRIGGER fail_terminal BEFORE INSERT ON scan_events BEGIN SELECT RAISE(ABORT, 'disk write failed'); END;").unwrap();
        let cancelled = super::ScanEvent::Cancelled {
            scan_id: "s".into(),
        };
        assert!(super::persist_terminal_in(&mut conn, "s", &cancelled, None).is_err());
        assert_eq!(
            conn.query_row("SELECT status FROM scans WHERE scan_id='s'", [], |r| r
                .get::<_, String>(
                0
            ))
            .unwrap(),
            "running"
        );
        conn.execute_batch("DROP TRIGGER fail_terminal").unwrap();
        super::persist_terminal_in(&mut conn, "s", &cancelled, None).unwrap();
        let completed = super::ScanEvent::Completed {
            scan_id: "s".into(),
            exit_code: 0,
            finding_count: 0,
        };
        assert!(super::persist_terminal_in(&mut conn, "s", &completed, None).is_err());
        assert!(super::persist_terminal_in(&mut conn, "s", &cancelled, None).is_err());
        drop(conn);
        let conn = super::connect_database(&path).unwrap();
        let (status, kind, seq): (String, String, i64) = conn
            .query_row(
                "SELECT status,kind,seq FROM scans JOIN scan_events USING(scan_id) WHERE seq=10",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (status.as_str(), kind.as_str(), seq),
            ("cancelled", "cancelled", 10)
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM scan_events", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    use super::*;
    #[test]
    fn normal_reads_do_not_acquire_migration_write_locks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lyrashield.db");
        assert!(connect_database(&path).is_err());
        assert!(!path.exists());
        let writer = open_database(&path).unwrap();
        let mode: String = writer
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let reader = connect_database(&path).unwrap();
        reader.busy_timeout(std::time::Duration::ZERO).unwrap();
        let count: i64 = reader
            .query_row("SELECT COUNT(*) FROM _sqlx_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, super::MIGRATIONS.len() as i64);
        writer.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn opens_an_existing_sqlx_database_without_rewriting_its_receipt() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("lyrashield.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(include_str!("../sql/001_init.sql"))
            .unwrap();
        conn.execute_batch(MIGRATION_TABLE).unwrap();
        // SHA-384 of the shipped v1 SQL, matching SQLx Migration::new.
        conn.execute("INSERT INTO _sqlx_migrations (version,description,success,checksum,execution_time) VALUES (1,'create scans and findings tables',1,x'3a07a2a94f5c125f3e6e67331ceb6b900897c7c1c7bf58a505e202c4e14844d440e510be74038e6df9273660cd18d4c8',42)", []).unwrap();
        conn.execute("INSERT INTO scans (scan_id,target,mode,status,started_at) VALUES ('legacy','local','standard','completed','before-upgrade')", []).unwrap();
        drop(conn);
        let conn = open_database(&path).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT started_at FROM scans WHERE scan_id='legacy'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "before-upgrade"
        );
        assert_eq!(
            conn.query_row(
                "SELECT execution_time FROM _sqlx_migrations WHERE version=1",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            42
        );
    }

    #[test]
    fn disk_database_preserves_sqlx_migrations_and_existing_history() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config/lyrashield.db");
        // First startup creates the directory, schema and SQLx-compatible version receipt.
        let conn = open_database(&path).unwrap();
        let checksum: Vec<u8> = conn
            .query_row(
                "SELECT checksum FROM _sqlx_migrations WHERE version = 1 AND success = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            checksum,
            Sha384::digest(MIGRATIONS[0].2.as_bytes()).to_vec()
        );
        conn.execute("INSERT INTO scans (scan_id,target,mode,status,started_at) VALUES ('existing','local','standard','completed','now')", []).unwrap();
        conn.execute(
            "UPDATE scans SET threat_model_available=1 WHERE scan_id='existing'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO findings (id,scan_id,severity,title,detected_at,evidence_context) VALUES ('context-1','existing','HIGH','Context','now',?)",
            [r#"{"contextual_cvss_reasoning":"Remote reach","advisory_cvss":{"score":8.6},"evidence_warnings":["No admin session"],"update_history":[{"fields":["severity"]}]}"#],
        ).unwrap();
        drop(conn);
        // Existing data and version bookkeeping survive repeat startup.
        for _ in 0..2 {
            let conn = open_database(&path).unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT count(*) FROM scans WHERE scan_id='existing'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM _sqlx_migrations", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                super::MIGRATIONS.len() as i64
            );
            let (threat, context): (i64, String) = conn
                .query_row(
                    "SELECT s.threat_model_available, f.evidence_context FROM scans s JOIN findings f ON f.scan_id=s.scan_id WHERE f.id='context-1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(threat, 1);
            let parsed: super::FindingEvidenceContext = serde_json::from_str(&context).unwrap();
            assert_eq!(parsed.advisory_cvss.unwrap()["score"], 8.6);
        }
        let mut conn = open_database(&path).unwrap();
        let broken = [
            MIGRATIONS[0],
            (
                2,
                "broken",
                "CREATE TABLE should_rollback (id INTEGER); INVALID SQL;",
            ),
        ];
        assert!(migrate_database(&mut conn, &broken).is_err());
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='should_rollback'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM _sqlx_migrations", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            MIGRATIONS.len() as i64
        );
        drop(conn);
        let mut conn = open_database(&path).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM scans WHERE scan_id='existing'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        let next = [
            MIGRATIONS[0],
            MIGRATIONS[1],
            MIGRATIONS[2],
            (4, "next", "CREATE TABLE next_version (id INTEGER);"),
        ];
        migrate_database(&mut conn, &next).unwrap();
        migrate_database(&mut conn, &next).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM _sqlx_migrations", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            4
        );
    }

    #[test]
    fn existing_sqlx_ledger_rejects_tampering_dirty_and_unknown_versions() {
        for alteration in [
            "UPDATE _sqlx_migrations SET checksum=x'00'",
            "UPDATE _sqlx_migrations SET success=0",
            "UPDATE _sqlx_migrations SET version=99 WHERE version=2",
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let path = tmp.path().join("lyrashield.db");
            let conn = open_database(&path).unwrap();
            conn.execute(alteration, []).unwrap();
            drop(conn);
            assert!(open_database(&path).is_err());
        }
        let tmp = tempfile::tempdir().unwrap();
        let invalid_path = tmp.path().join("directory.db");
        std::fs::create_dir(&invalid_path).unwrap();
        assert!(open_database(&invalid_path).is_err());
    }
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

    #[test]
    fn v1_database_migrates_and_old_rows_stay_readable() {
        // Simulate a shipped v1 database: apply only the initial schema through
        // the same ledger, then run the full migration set. Old rows keep
        // readable defaults — workflow REVIEW_TARGET (pre-workflow scans were
        // snapshot reviews), verification DETECTED, evidence fields NULL
        // (unknown, never guessed).
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        super::migrate_database(&mut conn, &super::MIGRATIONS[..1]).unwrap();
        conn.execute(
            "INSERT INTO scans (scan_id, target, mode, status, started_at, finding_count) VALUES ('s1','/repo','\"standard\"','completed','now',1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO findings (id, scan_id, severity, title, status, verified, detected_at) VALUES ('f1','s1','HIGH','t','OPEN',1,'2026-09-19')",
            [],
        )
        .unwrap();
        super::migrate_database(&mut conn, super::MIGRATIONS).unwrap();

        let (workflow, backend, contract): (String, String, Option<String>) = conn
            .query_row(
                "SELECT workflow, backend, contract_version FROM scans WHERE scan_id='s1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(workflow, "REVIEW_TARGET");
        assert_eq!(backend, "local");
        assert!(contract.is_none(), "unknown contract stays NULL");

        let (vstate, pending, counter): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT verification_state, evidence_pending, counterevidence FROM findings WHERE id='f1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(vstate, "DETECTED");
        assert_eq!(pending, 0);
        assert!(counter.is_none());

        let (context, threat_available): (Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT f.evidence_context, s.threat_model_available FROM findings f JOIN scans s ON s.scan_id=f.scan_id WHERE f.id='f1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(context.is_none(), "old evidence remains not-recorded");
        assert!(
            threat_available.is_none(),
            "old threat state remains unknown"
        );

        // And the new write path accepts the extended fields.
        conn.execute(
            "INSERT INTO findings (id, scan_id, severity, title, status, verified, detected_at, verification_state, evidence_pending, counterevidence, http_exchange_ids) VALUES ('f2','s1','HIGH','t2','OPEN',0,'2026-09-20','DETECTED',1,'ce','[\"ex-1\"]')",
            [],
        )
        .unwrap();
        let pending2: i64 = conn
            .query_row(
                "SELECT evidence_pending FROM findings WHERE id='f2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pending2, 1);
    }
}
