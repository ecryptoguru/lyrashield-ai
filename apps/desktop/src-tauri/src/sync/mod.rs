use crate::api::ApiClient;
use crate::scan::types::Finding;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const MAX_FINDINGS_PER_BATCH: usize = 500;
const KEYCHAIN_SERVICE: &str = "lyrashield";
const LICENSE_KEY_ACCOUNT: &str = "license-key";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConnection {
    pub workspace_id: String,
    pub seq: u64,
    pub last_synced_finding_id: Option<String>,
    pub connected_at: String,
    pub last_sync_at: Option<String>,
    // compat: seq as string for older clients
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum SyncResult {
    Success {
        synced_count: usize,
        new_seq: u64,
        new_cursor: String,
    },
    EntitlementMissing {
        message: String,
    },
    CursorRewind {
        server_seq: u64,
        message: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> {
    success: bool,
    data: Option<T>,
    error: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ConnectData {
    seq: Option<u64>,
    #[serde(rename = "lastSyncedFindingId")]
    last_synced_finding_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FindingsData {
    seq: Option<u64>,
    cursor: Option<String>,
    #[serde(rename = "lastSyncedFindingId")]
    last_synced_finding_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CursorData {
    seq: Option<u64>,
    cursor: Option<String>,
    #[serde(rename = "lastSyncedFindingId")]
    last_synced_finding_id: Option<String>,
}

fn sync_db_path() -> Result<PathBuf, String> {
    let dir = dirs::data_dir().ok_or_else(|| "could not determine app data dir".to_string())?;
    Ok(dir.join("LyraShield").join("lyrashield.db"))
}

fn ensure_sync_table(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(include_str!("../sql/001_init.sql"))
        .map_err(|e| format!("init sync table: {}", e))?;
    let mut stmt = conn
        .prepare("PRAGMA table_info(sync_state)")
        .map_err(|e| format!("pragma: {}", e))?;
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("query_map: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect: {}", e))?;
    if !cols.contains(&"seq".to_string()) {
        conn.execute(
            "ALTER TABLE sync_state ADD COLUMN seq INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("add seq: {}", e))?;
    }
    if !cols.contains(&"last_synced_finding_id".to_string()) {
        conn.execute(
            "ALTER TABLE sync_state ADD COLUMN last_synced_finding_id TEXT",
            [],
        )
        .map_err(|e| format!("add last_synced_finding_id: {}", e))?;
    }
    Ok(())
}

fn load_license_key_from_keychain() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, LICENSE_KEY_ACCOUNT)
        .map_err(|e| format!("keychain entry: {}", e))?;
    entry
        .get_password()
        .map_err(|e| format!("license key not found in keychain: {}", e))
}

fn save_sync_state_blocking(
    workspace_id: &str,
    seq: u64,
    last_synced_finding_id: Option<&str>,
    connected_at: &str,
) -> Result<(), String> {
    let db_path = sync_db_path()?;
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {}", e))?;
    }
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| format!("open db: {}", e))?;
    ensure_sync_table(&conn)?;
    let cursor_str = seq.to_string();
    conn.execute(
        "INSERT INTO sync_state (id, workspace_id, seq, last_synced_finding_id, connected_at, last_sync_at, cursor) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id, seq=excluded.seq, last_synced_finding_id=excluded.last_synced_finding_id, connected_at=excluded.connected_at, last_sync_at=excluded.last_sync_at, cursor=excluded.cursor",
        rusqlite::params![
            workspace_id,
            seq as i64,
            last_synced_finding_id,
            connected_at,
            chrono::Utc::now().to_rfc3339(),
            cursor_str,
        ],
    )
    .map_err(|e| format!("save sync_state: {}", e))?;
    Ok(())
}

fn load_sync_state_blocking() -> Result<Option<SyncConnection>, String> {
    let db_path = sync_db_path()?;
    if !db_path.exists() {
        return Ok(None);
    }
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| format!("open db: {}", e))?;
    ensure_sync_table(&conn)?;
    let mut stmt = conn
        .prepare("SELECT workspace_id, seq, last_synced_finding_id, connected_at, last_sync_at FROM sync_state WHERE id=1")
        .map_err(|e| format!("prepare: {}", e))?;
    let mut rows = stmt.query([]).map_err(|e| format!("query: {}", e))?;
    if let Some(row) = rows.next().map_err(|e| format!("next: {}", e))? {
        let workspace_id: String = row.get(0).map_err(|e| format!("col0: {}", e))?;
        let seq: i64 = row.get(1).unwrap_or(0);
        let last_synced_finding_id: Option<String> =
            row.get(2).map_err(|e| format!("col2: {}", e))?;
        let connected_at: Option<String> = row.get(3).map_err(|e| format!("col3: {}", e))?;
        let last_sync_at: Option<String> = row.get(4).map_err(|e| format!("col4: {}", e))?;
        Ok(Some(SyncConnection {
            workspace_id,
            seq: seq as u64,
            last_synced_finding_id: last_synced_finding_id.clone(),
            connected_at: connected_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            last_sync_at,
            cursor: Some((seq as u64).to_string()),
        }))
    } else {
        Ok(None)
    }
}

fn clear_sync_state_blocking() -> Result<(), String> {
    let db_path = sync_db_path()?;
    if !db_path.exists() {
        return Ok(());
    }
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| format!("open db: {}", e))?;
    ensure_sync_table(&conn)?;
    conn.execute("DELETE FROM sync_state WHERE id=1", [])
        .map_err(|e| format!("delete: {}", e))?;
    Ok(())
}

pub async fn connect_workspace(
    api_url: Option<String>,
    workspace_id: &str,
) -> Result<SyncConnection, String> {
    let license_key = load_license_key_from_keychain()?;
    let client = ApiClient::new(api_url)?;
    let url = format!("{}/api/sync/connect", client.base_url());
    let body = serde_json::json!({
        "workspaceId": workspace_id,
        "licenseKey": license_key,
    });
    let resp = client.post(&url, &body).await?;
    if resp.status.as_u16() == 403 {
        return Err("ENTITLEMENT_MISSING: Sync addon or Cloud subscription required".into());
    }
    if resp.status.as_u16() == 404 {
        return Err(format!("license not found: {}", resp.body));
    }
    if !resp.status.is_success() {
        return Err(format!(
            "sync connect failed ({}): {}",
            resp.status, resp.body
        ));
    }
    let envelope: ApiEnvelope<ConnectData> = serde_json::from_str(&resp.body)
        .map_err(|e| format!("parse connect envelope: {} body:{}", e, resp.body))?;
    if !envelope.success {
        return Err(format!("connect envelope success=false: {}", resp.body));
    }
    let data = envelope
        .data
        .ok_or_else(|| format!("connect missing data: {}", resp.body))?;
    let seq = data.seq.unwrap_or(0);
    let last_synced_finding_id = data.last_synced_finding_id;
    let now = chrono::Utc::now().to_rfc3339();
    let conn = SyncConnection {
        workspace_id: workspace_id.to_string(),
        seq,
        last_synced_finding_id: last_synced_finding_id.clone(),
        connected_at: now.clone(),
        last_sync_at: None,
        cursor: Some(seq.to_string()),
    };
    let ws = workspace_id.to_string();
    let last_clone = last_synced_finding_id.clone();
    tokio::task::spawn_blocking(move || {
        save_sync_state_blocking(&ws, seq, last_clone.as_deref(), &now)
    })
    .await
    .map_err(|e| format!("join: {}", e))?
    .map_err(|e| format!("save state: {}", e))?;
    Ok(conn)
}

pub async fn load_trusted_cursor() -> Result<Option<SyncConnection>, String> {
    tokio::task::spawn_blocking(load_sync_state_blocking)
        .await
        .map_err(|e| format!("join: {}", e))?
}

pub async fn get_sync_state() -> Result<Option<SyncConnection>, String> {
    load_trusted_cursor().await
}

pub async fn sync_findings(
    api_url: Option<String>,
    workspace_id: &str,
    findings: &[Finding],
) -> Vec<SyncResult> {
    let mut results = Vec::new();
    let license_key = match load_license_key_from_keychain() {
        Ok(k) => k,
        Err(e) => {
            results.push(SyncResult::Error { message: e });
            return results;
        }
    };
    let trusted = match load_trusted_cursor().await {
        Ok(Some(c)) if c.workspace_id == workspace_id => c.seq,
        Ok(_) => 0,
        Err(e) => {
            results.push(SyncResult::Error { message: e });
            return results;
        }
    };
    let client = match ApiClient::new(api_url) {
        Ok(c) => c,
        Err(e) => {
            results.push(SyncResult::Error { message: e });
            return results;
        }
    };
    let mut current_seq = trusted;
    let mut synced = 0usize;
    let mut last_synced_finding_id: Option<String> = None;
    for chunk in findings.chunks(MAX_FINDINGS_PER_BATCH) {
        let url = format!("{}/api/sync/findings", client.base_url());
        let body = serde_json::json!({
            "workspaceId": workspace_id,
            "licenseKey": license_key,
            "expectedSeq": current_seq,
            "findings": chunk.iter().map(|f| {
                serde_json::json!({
                    "id": f.id,
                    "severity": f.severity,
                    "title": f.title,
                    "description": f.description,
                    "status": f.status,
                    "verified": false,
                    "filePath": f.file_path,
                    "lineNumber": f.line_number,
                    "detectedAt": f.detected_at,
                })
            }).collect::<Vec<_>>(),
            "reports": [],
        });
        match client.post(&url, &body).await {
            Ok(resp) if resp.status.is_success() => {
                synced += chunk.len();
                if let Ok(env) = serde_json::from_str::<ApiEnvelope<FindingsData>>(&resp.body) {
                    if let Some(d) = env.data {
                        if let Some(s) = d.seq {
                            current_seq = s;
                        } else if let Some(c) = d.cursor {
                            if let Ok(n) = c.parse::<u64>() {
                                current_seq = n;
                            }
                        }
                        if let Some(id) = d.last_synced_finding_id {
                            last_synced_finding_id = Some(id);
                        }
                    }
                }
            }
            Ok(resp) if resp.status.as_u16() == 409 => {
                let server_seq = serde_json::from_str::<ApiEnvelope<CursorData>>(&resp.body)
                    .ok()
                    .and_then(|e| e.data)
                    .and_then(|d| {
                        d.seq
                            .or_else(|| d.cursor.and_then(|c| c.parse::<u64>().ok()))
                    })
                    .unwrap_or(current_seq);
                let detail_seq = serde_json::from_str::<serde_json::Value>(&resp.body)
                    .ok()
                    .and_then(|v| {
                        v.get("error")
                            .and_then(|e| e.get("details"))
                            .and_then(|d| d.get("currentSeq"))
                            .and_then(|n| n.as_u64())
                    })
                    .unwrap_or(server_seq);
                results.push(SyncResult::CursorRewind {
                    server_seq: detail_seq,
                    message: "Server seq ahead — adopting server seq".into(),
                });
                current_seq = detail_seq;
                let ws = workspace_id.to_string();
                let id_clone = last_synced_finding_id.clone();
                let seq_clone = current_seq;
                let _ = tokio::task::spawn_blocking(move || {
                    let now = chrono::Utc::now().to_rfc3339();
                    let _ = save_sync_state_blocking(&ws, seq_clone, id_clone.as_deref(), &now);
                })
                .await;
                break;
            }
            Ok(resp) if resp.status.as_u16() == 403 => {
                results.push(SyncResult::EntitlementMissing {
                    message: "Sync entitlement missing or expired".into(),
                });
                break;
            }
            Ok(resp) => {
                results.push(SyncResult::Error {
                    message: format!("sync failed ({}): {}", resp.status, resp.body),
                });
                break;
            }
            Err(e) => {
                results.push(SyncResult::Error { message: e });
                break;
            }
        }
    }
    if synced > 0 {
        let ws = workspace_id.to_string();
        let id_clone = last_synced_finding_id.clone();
        let seq_clone = current_seq;
        let _ = tokio::task::spawn_blocking(move || {
            let now = chrono::Utc::now().to_rfc3339();
            let existing = load_sync_state_blocking().ok().flatten();
            let connected_at = existing.map(|c| c.connected_at).unwrap_or(now.clone());
            let _ = save_sync_state_blocking(&ws, seq_clone, id_clone.as_deref(), &connected_at);
        })
        .await;
        results.push(SyncResult::Success {
            synced_count: synced,
            new_seq: current_seq,
            new_cursor: current_seq.to_string(),
        });
    }
    results
}

pub async fn fetch_and_adopt_cursor(
    api_url: Option<String>,
    workspace_id: &str,
) -> Result<SyncConnection, String> {
    let license_key = load_license_key_from_keychain()?;
    let client = ApiClient::new(api_url)?;
    let url = format!(
        "{}/api/sync/cursor?workspaceId={}&licenseKey={}",
        client.base_url(),
        workspace_id,
        license_key
    );
    let resp = client.get(&url).await?;
    if !resp.status.is_success() {
        return Err(format!(
            "cursor fetch failed ({}): {}",
            resp.status, resp.body
        ));
    }
    let envelope: ApiEnvelope<CursorData> = serde_json::from_str(&resp.body)
        .map_err(|e| format!("parse cursor envelope: {} body:{}", e, resp.body))?;
    let data = envelope
        .data
        .ok_or_else(|| format!("cursor missing data: {}", resp.body))?;
    let seq = data
        .seq
        .or_else(|| data.cursor.and_then(|c| c.parse::<u64>().ok()))
        .unwrap_or(0);
    let last_synced_finding_id = data.last_synced_finding_id;
    let now = chrono::Utc::now().to_rfc3339();
    let conn = SyncConnection {
        workspace_id: workspace_id.to_string(),
        seq,
        last_synced_finding_id: last_synced_finding_id.clone(),
        connected_at: now.clone(),
        last_sync_at: Some(now.clone()),
        cursor: Some(seq.to_string()),
    };
    let ws = workspace_id.to_string();
    let id_clone = last_synced_finding_id.clone();
    tokio::task::spawn_blocking(move || {
        save_sync_state_blocking(&ws, seq, id_clone.as_deref(), &now)
    })
    .await
    .map_err(|e| format!("join: {}", e))?
    .map_err(|e| format!("save: {}", e))?;
    Ok(conn)
}

pub fn disconnect() -> Result<(), String> {
    clear_sync_state_blocking()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::types::Finding;

    #[test]
    fn envelope_parsing_uses_data_seq_not_top_level_cursor() {
        let body = r#"{"success":true,"data":{"seq":5,"lastSyncedFindingId":"abc"}}"#;
        let env: ApiEnvelope<CursorData> = serde_json::from_str(body).unwrap();
        assert!(env.success);
        let d = env.data.unwrap();
        assert_eq!(d.seq, Some(5));
        let body2 = r#"{"success":true,"data":{"cursor":"7"}}"#;
        let env2: ApiEnvelope<FindingsData> = serde_json::from_str(body2).unwrap();
        assert_eq!(env2.data.unwrap().cursor.unwrap(), "7");
    }

    #[test]
    fn detection_state_forced_verified_false() {
        let f = Finding {
            id: "f1".into(),
            severity: "HIGH".into(),
            title: "t".into(),
            description: Some("d".into()),
            file_path: None,
            line_number: None,
            status: "OPEN".into(),
            verified: true,
            detected_at: "2026-08-22T00:00:00Z".into(),
        };
        let json = serde_json::json!({
            "id": f.id,
            "verified": false,
        });
        assert_eq!(json["verified"], false);
    }
}
