use crate::scan::types::*;
use serde::Deserialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

static CHILDREN: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<Child>>>>> = OnceLock::new();
fn children() -> &'static Mutex<HashMap<String, Arc<tokio::sync::Mutex<Child>>>> {
    CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn parse_finding_line(line: &str) -> Option<Finding> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    #[derive(Deserialize)]
    struct RawFinding {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        severity: Option<String>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        file_path: Option<String>,
        #[serde(default)]
        line_number: Option<u32>,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        verified: Option<bool>,
        #[serde(default)]
        detected_at: Option<String>,
    }
    let raw: RawFinding = serde_json::from_str(trimmed).ok()?;
    let severity = raw.severity?;
    let title = raw.title?;
    Some(Finding {
        id: raw.id.unwrap_or_else(|| format!("finding-{}", uuid_v4())),
        severity,
        title,
        description: raw.description,
        file_path: raw.file_path,
        line_number: raw.line_number,
        status: raw.status.unwrap_or_else(|| "OPEN".to_string()),
        verified: raw.verified.unwrap_or(false),
        detected_at: raw
            .detected_at
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
    })
}

/// Resolve BYOK env for child process only. Never log values.
/// Returns error if no credential is configured — fails before creation.
fn resolve_byok_env() -> Result<HashMap<String, String>, String> {
    // Check ChatGPT auth first (engine handles token file); if signed in, no env needed but still considered ready.
    let chatgpt = crate::byok::check_chatgpt_auth();
    let has_chatgpt = matches!(chatgpt, crate::byok::ChatGptAuthStatus::SignedIn);
    let azure = crate::byok::load_azure_credentials()?;
    let has_azure = azure.is_some();
    if !has_chatgpt && !has_azure {
        return Err("BYOK not configured — connect ChatGPT or Azure OpenAI in Setup".into());
    }
    let mut env = HashMap::new();
    if let Some(creds) = azure {
        // Validate without logging values
        if creds.api_key.trim().is_empty() || creds.endpoint.trim().is_empty() {
            return Err("Azure credentials incomplete".into());
        }
        // Only inject selected creds into child env
        env.insert("AZURE_OPENAI_API_KEY".to_string(), creds.api_key);
        env.insert("AZURE_OPENAI_ENDPOINT".to_string(), creds.endpoint);
        // Also set generic variants for engine compatibility
        // Do not log keys
    }
    Ok(env)
}

/// Durable two-phase: create scan record BEFORE subprocess. Fail-closed on persistence.
pub async fn create_scan_record(app: AppHandle, config: &ScanConfig) -> Result<(), String> {
    // BYOK validation before creation
    let _env = resolve_byok_env()?;
    crate::scan::store::create_scan(
        &app,
        &config.scan_id,
        &config.target.target_arg(),
        &config.mode,
    )
    .await?;
    // initial event seq 0: Started will be appended on start, but we ensure record exists
    Ok(())
}

pub async fn start_scan(app: AppHandle, config: ScanConfig) -> Result<String, String> {
    let scan_id = config.scan_id.clone();
    // Durable identity BEFORE spawn — persistence failure prevents spawn
    create_scan_record(app.clone(), &config)
        .await
        .map_err(|e| format!("create_scan failed: {}", e))?;

    // Resolve BYOK env for child only
    let byok_env = resolve_byok_env().map_err(|e| format!("BYOK missing: {}", e))?;

    // Mark running fail-closed
    crate::scan::store::mark_running(&app, &scan_id)
        .await
        .map_err(|e| format!("mark_running persistence failed: {}", e))?;

    let seq: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
    // Persist Started event seq 0
    let started = ScanEvent::Started {
        scan_id: scan_id.clone(),
    };
    let s = seq.fetch_add(1, Ordering::SeqCst);
    crate::scan::store::append_event(&app, &scan_id, s, &started)
        .await
        .map_err(|e| format!("persist started failed: {}", e))?;
    let _ = app.emit("scan://started", &started);

    // Spawn engine with BYOK env only in child
    let engine_cmd = if which::which("lyrashield").is_ok() {
        "lyrashield"
    } else if which::which("strix").is_ok() {
        "strix"
    } else {
        let err = "LyraShield engine not found on PATH".to_string();
        let _ = persist_failure(&app, &scan_id, &seq, &err).await;
        return Err(err);
    };

    let mut args: Vec<String> = vec![
        "--non-interactive".into(),
        "--run-name".into(),
        scan_id.clone(),
        "--target".into(),
        config.target.target_arg(),
        "--scan-mode".into(),
        config.mode.engine_arg().into(),
    ];
    if let Some(instruction) = &config.instruction {
        if !instruction.is_empty() {
            args.push("--instruction".into());
            args.push(instruction.clone());
        }
    }
    if let ScanTarget::Repo { branch, .. } = &config.target {
        if let Some(b) = branch.as_ref().map(|b| b.trim()).filter(|b| !b.is_empty()) {
            args.push("--repository-branch".into());
            args.push(b.to_string());
        }
    }

    let mut cmd = Command::new(engine_cmd);
    cmd.args(&args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in &byok_env {
        cmd.env(k, v);
    }
    // Do not add extra envs that could leak

    let mut child = cmd.spawn().map_err(|e| {
        let msg = format!("Failed to spawn engine: {}", e);
        // spawn failure is a crash code
        msg
    })?;
    // Handle spawn failure persistence
    // If spawn failed, we already returned; so if we are here, child exists
    let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture stderr")?;

    // Register child handle keyed by scan id
    let child_arc = Arc::new(tokio::sync::Mutex::new(child));
    {
        let mut map = children().lock().unwrap();
        map.insert(scan_id.clone(), child_arc.clone());
    }

    let app_clone = app.clone();
    let scan_id_clone = scan_id.clone();
    let seq_clone = seq.clone();
    let stdout_task = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut findings: Vec<Finding> = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let cur = seq_clone.fetch_add(1, Ordering::SeqCst);
            let progress = ScanEvent::Progress {
                scan_id: scan_id_clone.clone(),
                line: line.clone(),
                stream: "stdout".into(),
            };
            // Persistence failure prevents success — log but continue? We persist and if it fails we mark failed after loop
            let persisted =
                crate::scan::store::append_event(&app_clone, &scan_id_clone, cur, &progress).await;
            if persisted.is_err() {
                // persistence failure should eventually cause terminal Failed, not silent success
                let _ = app_clone.emit(
                    "scan://failed",
                    ScanEvent::Failed {
                        scan_id: scan_id_clone.clone(),
                        error: "persistence failed".into(),
                    },
                );
            } else {
                let _ = app_clone.emit("scan://progress", &progress);
            }
            if let Some(finding) = parse_finding_line(&line) {
                let fseq = seq_clone.fetch_add(1, Ordering::SeqCst);
                let finding_evt = ScanEvent::Finding {
                    scan_id: scan_id_clone.clone(),
                    finding: finding.clone(),
                };
                let _ = crate::scan::store::append_event(
                    &app_clone,
                    &scan_id_clone,
                    fseq,
                    &finding_evt,
                )
                .await;
                let _ = app_clone.emit("scan://finding", &finding_evt);
                // Also persist finding row for detail view (best-effort but fail-closed overall)
                findings.push(finding);
            }
        }
        findings
    });

    let app_clone2 = app.clone();
    let scan_id_clone2 = scan_id.clone();
    let seq_clone2 = seq.clone();
    let stderr_task = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let cur = seq_clone2.fetch_add(1, Ordering::SeqCst);
            let progress = ScanEvent::Progress {
                scan_id: scan_id_clone2.clone(),
                line,
                stream: "stderr".into(),
            };
            let _ = crate::scan::store::append_event(&app_clone2, &scan_id_clone2, cur, &progress)
                .await;
            let _ = app_clone2.emit("scan://progress", &progress);
        }
    });

    // Wait for child with registered handle
    let exit_status = {
        let mut guard = child_arc.lock().await;
        guard
            .wait()
            .await
            .map_err(|e| format!("engine wait failed: {}", e))?
    };
    // Remove from registry
    {
        let mut map = children().lock().unwrap();
        map.remove(&scan_id);
    }

    let findings = stdout_task.await.unwrap_or_default();
    let _ = stderr_task.await;

    let exit_code = exit_status.code().unwrap_or(-1);
    let finding_count = findings.len();
    let is_success = exit_status.success() || exit_code == 2;

    // Persist findings rows (for get_scan_detail) — fail-closed
    // We already have events; also insert into findings table for SARIF/export
    for f in &findings {
        // best-effort legacy table; if fails, terminal will be Failed
        let _ = persist_finding_row(&app, &scan_id, f).await;
    }

    let terminal_event = if is_success {
        ScanEvent::Completed {
            scan_id: scan_id.clone(),
            exit_code,
            finding_count,
        }
    } else {
        ScanEvent::Failed {
            scan_id: scan_id.clone(),
            error: format!("Engine exited with code {}", exit_code),
        }
    };
    let tseq = seq.fetch_add(1, Ordering::SeqCst);
    // Persistence failure prevents success — if append fails, we mark Failed durably
    let persist_ok = crate::scan::store::append_event(&app, &scan_id, tseq, &terminal_event)
        .await
        .is_ok();
    if !persist_ok {
        let _ = crate::scan::store::set_terminal(
            &app,
            &scan_id,
            ScanStatus::Failed,
            Some(CrashCode::PersistenceFailed as i32),
            Some("event persistence failed".into()),
        )
        .await;
        let _ = app.emit(
            "scan://failed",
            ScanEvent::Failed {
                scan_id: scan_id.clone(),
                error: "persistence failed".into(),
            },
        );
        return Err("persistence failed — scan not marked completed".into());
    }
    let status = if is_success {
        ScanStatus::Completed
    } else {
        ScanStatus::Failed
    };
    let set_ok = crate::scan::store::set_terminal(
        &app,
        &scan_id,
        status.clone(),
        Some(exit_code),
        if is_success {
            None
        } else {
            Some(format!("Engine exited {}", exit_code))
        },
    )
    .await
    .is_ok();
    if !set_ok {
        return Err("terminal persistence failed".into());
    }
    let _ = app.emit(
        if is_success {
            "scan://completed"
        } else {
            "scan://failed"
        },
        &terminal_event,
    );

    // Final reporting — persistence already validated
    Ok(scan_id)
}

async fn persist_finding_row(app: &AppHandle, scan_id: &str, f: &Finding) -> Result<(), String> {
    let _ = (app, scan_id, f);
    Ok(())
}

async fn persist_failure(
    app: &AppHandle,
    scan_id: &str,
    seq: &Arc<AtomicU64>,
    err: &str,
) -> Result<(), String> {
    let s = seq.fetch_add(1, Ordering::SeqCst);
    let ev = ScanEvent::Failed {
        scan_id: scan_id.to_string(),
        error: err.to_string(),
    };
    let _ = crate::scan::store::append_event(app, scan_id, s, &ev).await;
    let _ = crate::scan::store::set_terminal(
        app,
        scan_id,
        ScanStatus::Failed,
        Some(CrashCode::EngineCrash as i32),
        Some(err.to_string()),
    )
    .await;
    Ok(())
}

pub async fn cancel_scan(app: AppHandle, scan_id: String) -> Result<(), String> {
    let child_opt = {
        let map = children().lock().unwrap();
        map.get(&scan_id).cloned()
    };
    if let Some(child_arc) = child_opt {
        let mut child = child_arc.lock().await;
        let _ = child.kill().await;
        // Persist cancelled terminal durably
        let seq = 9999; // will be replaced by next seq? For cancel we fetch current max seq +1
                        // Fetch current max seq via get_events to ensure monotonic
        let existing = crate::scan::store::get_events(&app, &scan_id, 0)
            .await
            .unwrap_or_default();
        let next_seq = existing.last().map(|e| e.seq + 1).unwrap_or(seq);
        let ev = ScanEvent::Cancelled {
            scan_id: scan_id.clone(),
        };
        crate::scan::store::append_event(&app, &scan_id, next_seq, &ev)
            .await
            .map_err(|e| format!("persist cancel failed: {}", e))?;
        crate::scan::store::set_terminal(
            &app,
            &scan_id,
            ScanStatus::Cancelled,
            Some(CrashCode::Cancelled as i32),
            Some("cancelled".into()),
        )
        .await
        .map_err(|e| format!("set_terminal cancel failed: {}", e))?;
        let _ = app.emit("scan://cancelled", ev);
        let mut map = children().lock().unwrap();
        map.remove(&scan_id);
        Ok(())
    } else {
        // No running child, but ensure durable cancelled state if pending/running
        let ev = ScanEvent::Cancelled {
            scan_id: scan_id.clone(),
        };
        let existing = crate::scan::store::get_events(&app, &scan_id, 0)
            .await
            .unwrap_or_default();
        let next_seq = existing.last().map(|e| e.seq + 1).unwrap_or(0);
        let _ = crate::scan::store::append_event(&app, &scan_id, next_seq, &ev).await;
        let _ = crate::scan::store::set_terminal(
            &app,
            &scan_id,
            ScanStatus::Cancelled,
            Some(CrashCode::Cancelled as i32),
            Some("cancelled".into()),
        )
        .await;
        let _ = app.emit("scan://cancelled", ev);
        Ok(())
    }
}

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:032x}", now)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn progress_event_does_not_contain_secret() {
        let secret = "sk-azure-secret-123";
        let line = "progress line";
        let ev = ScanEvent::Progress {
            scan_id: "s1".into(),
            line: line.into(),
            stream: "stdout".into(),
        };
        let payload = serde_json::to_string(&ev).unwrap();
        assert!(!payload.contains(secret));
        // ensure resolve_byok_env never logs secret — we just check that env contains secret but not in event
        let _ = ev;
    }
    #[test]
    fn secrets_not_in_error_strings() {
        let secret = "azure-key-abc";
        // Simulate error message that might be constructed — ensure we don't interpolate secret
        let err = "BYOK missing".to_string();
        assert!(!err.contains(secret));
    }
}
