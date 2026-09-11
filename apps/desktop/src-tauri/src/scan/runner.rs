use crate::scan::types::*;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};

// VULN-F-002: engine stdout/stderr is untrusted output — a hostile scan
// target can drive arbitrary bytes. `BufReader::lines()` buffers each line
// unbounded and every line was persisted + emitted, so one no-newline line
// could OOM the process and a line flood could fill the event table. Bound
// per-line length, per-stream total bytes, and event count; an engine that
// exceeds the budget is hostile or malfunctioning and gets killed.
const MAX_STREAM_BYTES: usize = 32 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_STREAM_EVENTS: usize = 50_000;

#[derive(Default)]
struct StreamReadState {
    total_bytes: usize,
    exhausted: bool,
    pending: Vec<u8>,
    line_truncated: bool,
}

/// Read one newline-terminated line bounded by MAX_LINE_BYTES and a running
/// per-stream byte total. Returns Ok(None) at clean EOF or once the stream
/// budget is exhausted (flagged via `state.exhausted` so the caller can kill
/// the still-writing child instead of letting it block on a full pipe).
async fn next_bounded_line<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    state: &mut StreamReadState,
) -> Result<Option<String>, String> {
    loop {
        if state.exhausted || state.total_bytes >= MAX_STREAM_BYTES {
            state.exhausted = true;
            if !state.pending.is_empty() {
                let bytes = std::mem::take(&mut state.pending);
                let mut text = String::from_utf8_lossy(&bytes).to_string();
                text.push_str("…[truncated]");
                state.line_truncated = false;
                return Ok(Some(text));
            }
            return Ok(None);
        }
        let avail = reader
            .fill_buf()
            .await
            .map_err(|e| format!("engine stream read failed: {}", e))?;
        if avail.is_empty() {
            if state.pending.is_empty() && !state.line_truncated {
                return Ok(None);
            }
            let bytes = std::mem::take(&mut state.pending);
            let mut text = String::from_utf8_lossy(&bytes).to_string();
            if state.line_truncated {
                text.push_str("…[truncated]");
                state.line_truncated = false;
            }
            if text.ends_with('\r') {
                text.pop();
            }
            return Ok(Some(text));
        }
        let remaining = MAX_STREAM_BYTES - state.total_bytes;
        let take = avail.len().min(remaining);
        let slice = &avail[..take];
        let newline = slice.iter().position(|b| *b == b'\n');
        let data_len = newline.unwrap_or(slice.len());
        let consume_len = newline.map(|n| n + 1).unwrap_or(slice.len());
        let room = MAX_LINE_BYTES.saturating_sub(state.pending.len());
        if data_len > room {
            state.pending.extend_from_slice(&slice[..room]);
            state.line_truncated = true;
        } else {
            state.pending.extend_from_slice(&slice[..data_len]);
        }
        reader.consume(consume_len);
        state.total_bytes += consume_len;
        if newline.is_some() {
            let mut bytes = std::mem::take(&mut state.pending);
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            let mut text = String::from_utf8_lossy(&bytes).to_string();
            if state.line_truncated {
                text.push_str("…[truncated]");
                state.line_truncated = false;
            }
            return Ok(Some(text));
        }
        if state.total_bytes >= MAX_STREAM_BYTES {
            state.exhausted = true;
        }
    }
}

static CHILDREN: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<Child>>>>> = OnceLock::new();

pub fn validate_max_budget_usd(value: f64) -> Result<f64, String> {
    if !value.is_finite() || !(0.01..=100.0).contains(&value) {
        return Err("BYOK scan budget must be a finite amount between $0.01 and $100.00".into());
    }
    Ok(value)
}

fn children() -> &'static Mutex<HashMap<String, Arc<tokio::sync::Mutex<Child>>>> {
    CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
fn cancelled() -> &'static Mutex<HashSet<String>> {
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn take_cancelled(scan_id: &str) -> bool {
    cancelled().lock().unwrap().remove(scan_id)
}

const REDACTED: &str = "[REDACTED]";

fn ascii_matches_at(bytes: &[u8], start: usize, needle: &[u8]) -> bool {
    bytes
        .get(start..start + needle.len())
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(needle))
}

fn secret_end(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len()
        && !bytes[index].is_ascii_whitespace()
        && !matches!(
            bytes[index],
            b'"' | b'\'' | b',' | b';' | b'}' | b']' | b'&'
        )
    {
        index += 1;
    }
    index
}

fn push_labeled_secret_ranges(bytes: &[u8], ranges: &mut Vec<(usize, usize)>) {
    const LABELS: &[&[u8]] = &[
        b"azure_openai_api_key",
        b"openai_api_key",
        b"anthropic_api_key",
        b"accessToken",
        b"refreshToken",
        b"clientSecret",
        b"api_key",
        b"api-key",
        b"api key",
        b"apikey",
        b"access_token",
        b"access-token",
        b"refresh_token",
        b"client_secret",
        b"authorization",
        b"password",
        b"secret",
        b"token",
    ];

    for start in 0..bytes.len() {
        for label in LABELS {
            if !ascii_matches_at(bytes, start, label) {
                continue;
            }
            if start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_') {
                continue;
            }

            let mut value_start = start + label.len();
            while value_start < bytes.len()
                && (bytes[value_start].is_ascii_whitespace()
                    || matches!(bytes[value_start], b'"' | b'\''))
            {
                value_start += 1;
            }
            if value_start >= bytes.len() || !matches!(bytes[value_start], b':' | b'=') {
                continue;
            }
            value_start += 1;
            while value_start < bytes.len()
                && (bytes[value_start].is_ascii_whitespace()
                    || matches!(bytes[value_start], b'"' | b'\''))
            {
                value_start += 1;
            }
            if ascii_matches_at(bytes, value_start, b"bearer") {
                value_start += b"bearer".len();
                while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
                    value_start += 1;
                }
            }
            let value_end = secret_end(bytes, value_start);
            if value_end > value_start {
                ranges.push((value_start, value_end));
            }
        }
    }
}

fn push_bearer_ranges(bytes: &[u8], ranges: &mut Vec<(usize, usize)>) {
    for start in 0..bytes.len() {
        if !ascii_matches_at(bytes, start, b"bearer") {
            continue;
        }
        if start > 0 && bytes[start - 1].is_ascii_alphanumeric() {
            continue;
        }
        let mut value_start = start + b"bearer".len();
        if value_start >= bytes.len() || !bytes[value_start].is_ascii_whitespace() {
            continue;
        }
        while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
            value_start += 1;
        }
        let value_end = secret_end(bytes, value_start);
        if value_end > value_start {
            ranges.push((value_start, value_end));
        }
    }
}

fn push_prefixed_secret_ranges(bytes: &[u8], ranges: &mut Vec<(usize, usize)>) {
    const PREFIXES: &[&[u8]] = &[
        b"sk-ant-",
        b"github_pat_",
        b"polar_oat_",
        b"polar_pat_",
        b"lsk_",
        b"rzp_live_",
        b"rzp_test_",
        b"sk_live_",
        b"sk_test_",
        b"xoxb-",
        b"xoxp-",
        b"ghp_",
        b"AIza",
        b"AKIA",
        b"sk-",
    ];

    for start in 0..bytes.len() {
        for prefix in PREFIXES {
            if !bytes
                .get(start..start + prefix.len())
                .is_some_and(|candidate| candidate == *prefix)
            {
                continue;
            }
            let mut end = start + prefix.len();
            while end < bytes.len()
                && (bytes[end].is_ascii_alphanumeric() || matches!(bytes[end], b'_' | b'-'))
            {
                end += 1;
            }
            if end - start >= 16 {
                ranges.push((start, end));
            }
        }
    }
}

fn push_jwt_ranges(bytes: &[u8], ranges: &mut Vec<(usize, usize)>) {
    for start in 0..bytes.len().saturating_sub(3) {
        if bytes.get(start..start + 3) != Some(b"eyJ") {
            continue;
        }
        let mut end = start + 3;
        while end < bytes.len()
            && (bytes[end].is_ascii_alphanumeric() || matches!(bytes[end], b'_' | b'-' | b'.'))
        {
            end += 1;
        }
        let candidate = &bytes[start..end];
        if candidate
            .split(|byte| *byte == b'.')
            .filter(|part| part.len() >= 4)
            .count()
            == 3
            && candidate.iter().filter(|byte| **byte == b'.').count() == 2
        {
            ranges.push((start, end));
        }
    }
}

/// Redact credentials before engine output reaches parsing, persistence, or webview events.
fn redact_credentials(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut ranges = Vec::new();
    push_labeled_secret_ranges(bytes, &mut ranges);
    push_bearer_ranges(bytes, &mut ranges);
    push_prefixed_secret_ranges(bytes, &mut ranges);
    push_jwt_ranges(bytes, &mut ranges);
    if ranges.is_empty() {
        return line.to_owned();
    }

    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }

    let mut redacted = String::with_capacity(line.len());
    let mut cursor = 0;
    for (start, end) in merged {
        redacted.push_str(&line[cursor..start]);
        redacted.push_str(REDACTED);
        cursor = end;
    }
    redacted.push_str(&line[cursor..]);
    redacted
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
    validate_max_budget_usd(config.max_budget_usd)?;
    let scan_id = config.scan_id.clone();
    // Durable identity BEFORE spawn — persistence failure prevents spawn
    create_scan_record(app.clone(), &config)
        .await
        .map_err(|e| format!("create_scan failed: {}", e))?;

    tauri::async_runtime::spawn(async move {
        let runner_scan_id = config.scan_id.clone();
        if let Err(error) = run_scan(app.clone(), config).await {
            if !take_cancelled(&runner_scan_id) {
                let _ = persist_terminal_failure(&app, &runner_scan_id, &error).await;
            }
        }
    });

    Ok(scan_id)
}

async fn run_scan(app: AppHandle, config: ScanConfig) -> Result<(), String> {
    let scan_id = config.scan_id.clone();
    if take_cancelled(&scan_id) {
        return Ok(());
    }

    // Resolve BYOK env for child only
    let byok_env = resolve_byok_env().map_err(|e| format!("BYOK missing: {}", e))?;

    // Mark running fail-closed
    crate::scan::store::mark_running(&app, &scan_id)
        .await
        .map_err(|e| format!("mark_running persistence failed: {}", e))?;
    if take_cancelled(&scan_id) {
        return Ok(());
    }

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
    if take_cancelled(&scan_id) {
        return Ok(());
    }

    // Spawn engine with BYOK env only in child
    let engine_cmd = crate::runtime::resolve_engine_bin()?;

    let max_budget_usd = validate_max_budget_usd(config.max_budget_usd)?;
    let mut args: Vec<String> = vec![
        "--non-interactive".into(),
        "--run-name".into(),
        scan_id.clone(),
        "--target".into(),
        config.target.target_arg(),
        "--scan-mode".into(),
        config.mode.engine_arg().into(),
        "--max-budget-usd".into(),
        max_budget_usd.to_string(),
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
    cmd.env_clear();
    cmd.envs(crate::runtime::inherited_runtime_env());
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
    if take_cancelled(&scan_id) {
        let _ = child_arc.lock().await.kill().await;
        let mut map = children().lock().unwrap();
        map.remove(&scan_id);
        return Ok(());
    }

    // Kill-signal channel: a stream task that trips an output budget cannot
    // kill the child itself — `wait()` already holds the child mutex, so a
    // competing `kill()` would deadlock. The main flow owns the guard and
    // kills the engine on signal instead.
    let (kill_tx, mut kill_rx) = tokio::sync::mpsc::channel::<String>(2);

    let app_clone = app.clone();
    let scan_id_clone = scan_id.clone();
    let seq_clone = seq.clone();
    let stdout_kill = kill_tx.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::with_capacity(MAX_LINE_BYTES, stdout);
        let mut state = StreamReadState::default();
        let mut findings: Vec<Finding> = Vec::new();
        let mut persistence_error: Option<String> = None;
        let mut event_count: usize = 0;
        loop {
            let line = match next_bounded_line(&mut reader, &mut state).await {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(error) => {
                    let _ = stdout_kill.try_send(error.clone());
                    return Err(error);
                }
            };
            event_count += 1;
            if event_count > MAX_STREAM_EVENTS {
                let error = format!(
                    "engine exceeded the per-scan event budget ({})",
                    MAX_STREAM_EVENTS
                );
                let _ = stdout_kill.try_send(error.clone());
                return Err(error);
            }
            let line = redact_credentials(&line);
            let cur = seq_clone.fetch_add(1, Ordering::SeqCst);
            let progress = ScanEvent::Progress {
                scan_id: scan_id_clone.clone(),
                line: line.clone(),
                stream: "stdout".into(),
            };
            // Persistence failure prevents success — log but continue? We persist and if it fails we mark failed after loop
            let persisted =
                crate::scan::store::append_event(&app_clone, &scan_id_clone, cur, &progress).await;
            if let Err(error) = persisted {
                persistence_error.get_or_insert(error);
            } else {
                let _ = app_clone.emit("scan://progress", &progress);
            }
            if let Some(finding) = parse_finding_line(&line) {
                let fseq = seq_clone.fetch_add(1, Ordering::SeqCst);
                let finding_evt = ScanEvent::Finding {
                    scan_id: scan_id_clone.clone(),
                    finding: finding.clone(),
                };
                if let Err(error) =
                    crate::scan::store::append_event(&app_clone, &scan_id_clone, fseq, &finding_evt)
                        .await
                {
                    persistence_error.get_or_insert(error);
                } else {
                    let _ = app_clone.emit("scan://finding", &finding_evt);
                }
                if let Err(error) = persist_finding_row(&app_clone, &scan_id_clone, &finding).await
                {
                    persistence_error.get_or_insert(error);
                }
                findings.push(finding);
            }
        }
        if state.exhausted {
            // Engine wrote past the output budget — signal the main flow to
            // kill it rather than leave it blocked on a full pipe.
            let error = format!(
                "engine output exceeded the {}-byte stream budget",
                MAX_STREAM_BYTES
            );
            let _ = stdout_kill.try_send(error.clone());
            return Err(error);
        }
        if let Some(error) = persistence_error {
            Err(format!("scan persistence failed: {}", error))
        } else {
            Ok(findings)
        }
    });

    let app_clone2 = app.clone();
    let scan_id_clone2 = scan_id.clone();
    let seq_clone2 = seq.clone();
    let stderr_kill = kill_tx.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::with_capacity(MAX_LINE_BYTES, stderr);
        let mut state = StreamReadState::default();
        let mut event_count: usize = 0;
        loop {
            let line = match next_bounded_line(&mut reader, &mut state).await {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(error) => {
                    let _ = stderr_kill.try_send(error.clone());
                    return Err(error);
                }
            };
            event_count += 1;
            if event_count > MAX_STREAM_EVENTS {
                let error = format!(
                    "engine exceeded the per-scan event budget ({})",
                    MAX_STREAM_EVENTS
                );
                let _ = stderr_kill.try_send(error.clone());
                return Err(error);
            }
            let line = redact_credentials(&line);
            let cur = seq_clone2.fetch_add(1, Ordering::SeqCst);
            let progress = ScanEvent::Progress {
                scan_id: scan_id_clone2.clone(),
                line,
                stream: "stderr".into(),
            };
            crate::scan::store::append_event(&app_clone2, &scan_id_clone2, cur, &progress).await?;
            let _ = app_clone2.emit("scan://progress", &progress);
        }
        if state.exhausted {
            let error = format!(
                "engine output exceeded the {}-byte stream budget",
                MAX_STREAM_BYTES
            );
            let _ = stderr_kill.try_send(error.clone());
            return Err(error);
        }
        Ok::<(), String>(())
    });

    // Wait for child with registered handle — the guard is held across the
    // select, so a stream-task kill signal can kill the engine without
    // competing for the lock.
    let exit_status = {
        let mut guard = child_arc.lock().await;
        tokio::select! {
            status = guard.wait() => {
                status.map_err(|e| format!("engine wait failed: {}", e))?
            }
            _ = kill_rx.recv() => {
                let _ = guard.kill().await;
                guard
                    .wait()
                    .await
                    .map_err(|e| format!("engine wait failed: {}", e))?
            }
        }
    };
    // Remove from registry
    {
        let mut map = children().lock().unwrap();
        map.remove(&scan_id);
    }

    let findings = stdout_task
        .await
        .map_err(|error| format!("stdout task failed: {}", error))??;
    stderr_task
        .await
        .map_err(|error| format!("stderr task failed: {}", error))??;

    if take_cancelled(&scan_id) {
        return Ok(());
    }

    let exit_code = exit_status.code().unwrap_or(-1);
    let finding_count = findings.len();
    let is_success = exit_status.success() || exit_code == 2;

    crate::scan::store::set_finding_count(&app, &scan_id, finding_count).await?;

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
    Ok(())
}

async fn persist_finding_row(app: &AppHandle, scan_id: &str, f: &Finding) -> Result<(), String> {
    crate::scan::store::persist_finding(app, scan_id, f).await
}

async fn persist_terminal_failure(app: &AppHandle, scan_id: &str, err: &str) -> Result<(), String> {
    let existing = crate::scan::store::get_events(app, scan_id, 0).await?;
    let s = existing.last().map(|event| event.seq + 1).unwrap_or(0);
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
    let _ = app.emit("scan://failed", ev);
    Ok(())
}

pub async fn cancel_scan(app: AppHandle, scan_id: String) -> Result<(), String> {
    cancelled().lock().unwrap().insert(scan_id.clone());
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
    fn credentials_are_redacted_before_event_payloads() {
        let line = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature api_key=azure-key-abc rzp_test_1234567890abcdef lsk_example_secret_value";
        let redacted = redact_credentials(line);
        let ev = ScanEvent::Progress {
            scan_id: "s1".into(),
            line: redacted,
            stream: "stdout".into(),
        };
        let payload = serde_json::to_string(&ev).unwrap();
        assert!(!payload.contains("eyJhbGci"));
        assert!(!payload.contains("azure-key-abc"));
        assert!(!payload.contains("rzp_test_1234567890abcdef"));
        assert!(!payload.contains("lsk_example_secret_value"));
        assert_eq!(payload.matches(REDACTED).count(), 4);
    }

    #[test]
    fn credentials_are_redacted_before_finding_parse() {
        let line = r#"{"severity":"HIGH","title":"Leaked key","description":"client_secret: abc123secret","file_path":"src/config.ts"}"#;
        let redacted = redact_credentials(line);
        let finding = parse_finding_line(&redacted).unwrap();
        assert_eq!(
            finding.description.as_deref(),
            Some("client_secret: [REDACTED]")
        );
        assert!(!redacted.contains("abc123secret"));
    }

    #[test]
    fn injected_env_and_camel_case_credentials_are_redacted() {
        let line = "AZURE_OPENAI_API_KEY=azure-key-abc accessToken: browser-token";
        let redacted = redact_credentials(line);
        assert_eq!(redacted.matches(REDACTED).count(), 2);
        assert!(!redacted.contains("azure-key-abc"));
        assert!(!redacted.contains("browser-token"));
    }

    #[test]
    fn ordinary_progress_text_is_unchanged() {
        let line = "Scanned 200 files; no credential-shaped output";
        assert_eq!(redact_credentials(line), line);
    }

    #[test]
    fn local_budget_is_positive_and_bounded() {
        assert_eq!(validate_max_budget_usd(3.2).unwrap(), 3.2);
        assert_eq!(validate_max_budget_usd(0.015).unwrap().to_string(), "0.015");
        assert!(validate_max_budget_usd(0.009).is_err());
        assert!(validate_max_budget_usd(f64::INFINITY).is_err());
        assert!(validate_max_budget_usd(0.0).is_err());
        assert!(validate_max_budget_usd(f64::NAN).is_err());
        assert!(validate_max_budget_usd(101.0).is_err());
    }

    // VULN-F-002 — bounded engine-output reader (next_bounded_line)

    async fn bounded_lines(input: &[u8]) -> (Vec<String>, bool) {
        let (_w, r) = tokio::io::duplex(input.len() + 64);
        use tokio::io::AsyncWriteExt;
        let mut w = _w;
        w.write_all(input).await.unwrap();
        drop(w); // close the write half → clean EOF
        let mut reader = BufReader::new(r);
        let mut state = StreamReadState::default();
        let mut out = Vec::new();
        while let Some(line) = next_bounded_line(&mut reader, &mut state).await.unwrap() {
            out.push(line);
        }
        (out, state.exhausted)
    }

    #[tokio::test]
    async fn bounded_reader_reads_normal_lines() {
        let (lines, exhausted) = bounded_lines(b"one\ntwo\nthree\n").await;
        assert_eq!(lines, vec!["one", "two", "three"]);
        assert!(!exhausted);
    }

    #[tokio::test]
    async fn bounded_reader_truncates_giant_line() {
        let mut input = vec![b'x'; MAX_LINE_BYTES + 10_000];
        input.extend_from_slice(b"\ntail\n");
        let (lines, exhausted) = bounded_lines(&input).await;
        assert!(!exhausted);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("…[truncated]"));
        assert!(lines[0].len() <= MAX_LINE_BYTES + 20);
        assert_eq!(lines[1], "tail");
    }

    #[tokio::test]
    async fn bounded_reader_flags_stream_budget_exhaustion() {
        // A no-newline flood larger than the stream budget must exhaust the
        // reader rather than buffer it — the caller then kills the engine.
        let input = vec![b'y'; MAX_STREAM_BYTES + 1];
        let (lines, exhausted) = bounded_lines(&input).await;
        assert!(exhausted);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].ends_with("…[truncated]"));
    }

    #[tokio::test]
    async fn bounded_reader_emits_partial_final_line() {
        let (lines, exhausted) = bounded_lines(b"no-trailing-newline").await;
        assert!(!exhausted);
        assert_eq!(lines, vec!["no-trailing-newline"]);
    }
}
