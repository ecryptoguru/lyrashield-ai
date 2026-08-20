use crate::api::ApiClient;
use crate::scan::types::Finding;
use serde::{Deserialize, Serialize};

const MAX_FINDINGS_PER_BATCH: usize = 500;

/// Sync connection state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConnection {
    pub workspace_id: String,
    pub license_key: String,
    pub cursor: Option<String>,
    pub connected_at: String,
    pub last_sync_at: Option<String>,
}

/// Result of a sync operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum SyncResult {
    Success {
        synced_count: usize,
        new_cursor: String,
    },
    EntitlementMissing {
        message: String,
    },
    CursorRewind {
        server_cursor: String,
        message: String,
    },
    Error {
        message: String,
    },
}

/// Connect a workspace for cloud sync.
///
/// Calls `POST /api/sync/connect` with the workspace ID and license key.
/// The server enforces sync entitlement (sync_addon SKU or Cloud subscription).
pub async fn connect_workspace(
    api_url: Option<String>,
    workspace_id: &str,
    license_key: &str,
) -> Result<SyncConnection, String> {
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

    if !resp.status.is_success() {
        return Err(format!(
            "sync connect failed ({}): {}",
            resp.status, resp.body
        ));
    }

    Ok(SyncConnection {
        workspace_id: workspace_id.to_string(),
        license_key: license_key.to_string(),
        cursor: None,
        connected_at: chrono::Utc::now().to_rfc3339(),
        last_sync_at: None,
    })
}

/// Sync findings to the connected workspace.
///
/// Calls `POST /api/sync/findings` in batches of MAX_FINDINGS_PER_BATCH.
/// Handles 409 CURSOR_REWIND by adopting the server's cursor.
pub async fn sync_findings(
    api_url: Option<String>,
    connection: &SyncConnection,
    findings: &[Finding],
) -> Vec<SyncResult> {
    let mut results = Vec::new();
    let client = match ApiClient::new(api_url) {
        Ok(c) => c,
        Err(e) => {
            results.push(SyncResult::Error { message: e });
            return results;
        }
    };

    let mut cursor = connection.cursor.clone();
    let mut synced = 0usize;

    for chunk in findings.chunks(MAX_FINDINGS_PER_BATCH) {
        let url = format!("{}/api/sync/findings", client.base_url());

        let body = serde_json::json!({
            "workspaceId": connection.workspace_id,
            "licenseKey": connection.license_key,
            "findings": chunk.iter().map(|f| {
                serde_json::json!({
                    "id": f.id,
                    "severity": f.severity,
                    "title": f.title,
                    "description": f.description,
                    "status": f.status,
                    "verified": f.verified,
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
                // Parse new cursor from response if present.
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&resp.body) {
                    if let Some(c) = v.get("cursor").and_then(|c| c.as_str()) {
                        cursor = Some(c.to_string());
                    }
                }
            }
            Ok(resp) if resp.status.as_u16() == 409 => {
                // CURSOR_REWIND — adopt server cursor.
                let server_cursor = serde_json::from_str::<serde_json::Value>(&resp.body)
                    .ok()
                    .and_then(|v| v.get("cursor").and_then(|c| c.as_str()).map(String::from))
                    .unwrap_or_default();
                results.push(SyncResult::CursorRewind {
                    server_cursor: server_cursor.clone(),
                    message: "Server cursor is ahead — adopting server cursor".into(),
                });
                cursor = Some(server_cursor);
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
        results.push(SyncResult::Success {
            synced_count: synced,
            new_cursor: cursor.unwrap_or_default(),
        });
    }

    results
}

/// Disconnect sync by clearing local state.
pub fn disconnect() -> Result<(), String> {
    // The frontend clears the sync state from the SQL store.
    // No server call needed — the server keeps the cursor but the client
    // simply stops syncing.
    Ok(())
}
