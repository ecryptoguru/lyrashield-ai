use crate::scan::types::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
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

#[derive(Clone)]
struct ScanControl {
    cancel: tokio::sync::watch::Sender<bool>,
    finished: tokio::sync::watch::Receiver<Option<Result<(), String>>>,
}
impl ScanControl {
    async fn request_cancel(mut self) -> Result<(), String> {
        // Repeated requests share the owner's result; only that owner persists.
        self.cancel.send_replace(true);
        loop {
            if let Some(result) = self.finished.borrow().clone() {
                return result;
            }
            self.finished
                .changed()
                .await
                .map_err(|_| "scan owner stopped before confirming persistence".to_string())?;
        }
    }
}

fn cancelled_event(
    scan_id: &str,
    cancel: &tokio::sync::watch::Receiver<bool>,
) -> Option<ScanEvent> {
    (*cancel.borrow()).then(|| ScanEvent::Cancelled {
        scan_id: scan_id.to_owned(),
    })
}

static CONTROLS: OnceLock<Mutex<HashMap<String, ScanControl>>> = OnceLock::new();
fn controls() -> &'static Mutex<HashMap<String, ScanControl>> {
    CONTROLS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn validate_max_budget_usd(value: f64) -> Result<f64, String> {
    if !value.is_finite() || !(0.01..=100.0).contains(&value) {
        return Err("BYOK scan budget must be a finite amount between $0.01 and $100.00".into());
    }
    Ok(value)
}

/// Validate a launch request before any scan record, credential work, or
/// subprocess exists. Returns the canonical engine `--scan-mode` argument.
///
/// Rejects the obsolete `url` mode (a target kind, never an engine scan mode)
/// and any other non-depth stored value — never silently picking a tier.
/// Rejects URL targets: hosted URL scans run through domain verification and
/// the scoped relay / deterministic surface transport, none of which exist
/// locally. LyraShield Local never substitutes a BYOK-billed AI scan for them.
fn validate_launch(config: &ScanConfig) -> Result<&'static str, String> {
    let engine_mode = config.mode.engine_arg()?;
    if matches!(config.target, ScanTarget::Url { .. }) {
        return Err("URL targets require the hosted, domain-verified scan relay — launch them from the web app. LyraShield Local has no deterministic URL transport and never substitutes a BYOK AI scan.".into());
    }
    match config.workflow {
        ScanWorkflow::ReviewTarget => {
            if config.diff_base.is_some() || config.diff_head.is_some() {
                return Err(
                    "base/head refs apply only to a Review Changes scan — choose that workflow or clear them".into(),
                );
            }
        }
        ScanWorkflow::ReviewChanges => {
            // A diff review only makes sense against a repository checkout —
            // same contract as the hosted plan (REPO target, DIFF scope).
            if !matches!(
                config.target,
                ScanTarget::Repo { .. } | ScanTarget::LocalPath { .. }
            ) {
                return Err("Review Changes requires a repository checkout target".into());
            }
            let base = config
                .diff_base
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty());
            let base = base.ok_or("Review Changes requires a base ref to compare against")?;
            validate_diff_ref(base)?;
            if let Some(head) = config
                .diff_head
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                validate_diff_ref(head)?;
            }
        }
        ScanWorkflow::Unknown => {
            return Err(
                "unrecognized scan workflow — choose Review Target or Review Changes".into(),
            )
        }
    }
    Ok(engine_mode)
}

/// Git ref-shaped validation for the diff comparison pins. Branch names and
/// full SHAs are allowed; anything that could read as a flag or a range is
/// not (argv is never shell-evaluated, but a `-…` token would still be parsed
/// as an engine flag, and `a..b` would silently widen the comparison).
fn validate_diff_ref(value: &str) -> Result<&str, String> {
    let v = value.trim();
    if v.is_empty() || v.len() > 255 {
        return Err("diff ref must be 1–255 characters".into());
    }
    if v.starts_with('-') || v.contains("..") || v.contains("@{") {
        return Err("invalid diff ref".into());
    }
    if !v
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
    {
        return Err("invalid diff ref".into());
    }
    Ok(v)
}

// Only the owner touches the child. Cancellation never waits for a child mutex.
async fn wait_for_child(
    child: &mut Child,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
    kill: &mut tokio::sync::mpsc::Receiver<String>,
) -> Result<std::process::ExitStatus, String> {
    if !*cancel.borrow() {
        tokio::select! {
            biased;
            status = child.wait() => return status.map_err(|e| format!("engine wait failed: {}", e)),
            _ = cancel.changed() => {},
            _ = kill.recv() => {},
        }
    }
    child
        .kill()
        .await
        .map_err(|e| format!("engine termination failed: {}", e))?;
    child
        .wait()
        .await
        .map_err(|e| format!("engine wait failed: {}", e))
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

fn bounded_evidence_context(
    report: &serde_json::Map<String, serde_json::Value>,
) -> Option<FindingEvidenceContext> {
    let contextual_cvss_reasoning = report
        .get("contextual_cvss_reasoning")
        .and_then(|v| v.as_str())
        .filter(|s| s.len() <= 10_000)
        .map(str::to_string);
    let advisory_cvss = report.get("advisory_cvss").and_then(|value| {
        let object = value.as_object()?;
        let score = object.get("score")?.as_f64()?;
        if !score.is_finite() || !(0.0..=10.0).contains(&score) {
            return None;
        }
        let mut bounded = serde_json::Map::new();
        bounded.insert("score".into(), serde_json::json!(score));
        for (key, max) in [
            ("vector", 256),
            ("source", 256),
            ("metric_reasoning", 4_096),
        ] {
            if let Some(text) = object
                .get(key)
                .and_then(|v| v.as_str())
                .filter(|s| s.len() <= max)
            {
                bounded.insert(key.into(), serde_json::Value::String(text.into()));
            }
        }
        Some(serde_json::Value::Object(bounded))
    });
    let evidence_warnings: Vec<String> = report
        .get("evidence_warnings")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .take(10)
                .filter_map(|v| v.as_str().filter(|s| s.len() <= 10_000).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let update_history: Vec<serde_json::Value> = report
        .get("update_history")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .take(10)
                .filter(|v| v.is_object() && v.to_string().len() <= 4_096)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if contextual_cvss_reasoning.is_none()
        && advisory_cvss.is_none()
        && evidence_warnings.is_empty()
        && update_history.is_empty()
    {
        return None;
    }
    Some(FindingEvidenceContext {
        contextual_cvss_reasoning,
        advisory_cvss,
        evidence_warnings,
        update_history,
    })
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
        /// Engine self-attestation — never promoted to `verified` locally; it
        /// only raises `evidence_pending`.
        #[serde(default)]
        verified: Option<bool>,
        #[serde(default)]
        counterevidence: Option<String>,
        #[serde(default)]
        confidence_rationale: Option<String>,
        #[serde(default)]
        fix_verification: Option<serde_json::Value>,
        #[serde(default)]
        http_exchange_ids: Option<Vec<String>>,
        #[serde(default)]
        detected_at: Option<String>,
    }
    let raw_value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    let evidence_context = bounded_evidence_context(raw_value.as_object()?);
    let raw: RawFinding = serde_json::from_value(raw_value).ok()?;
    let severity = raw.severity?;
    let title = raw.title?;
    let http_exchange_ids = raw.http_exchange_ids.unwrap_or_default();
    let fix_verification = raw.fix_verification.map(|v| {
        if let Some(s) = v.as_str() {
            s.to_string()
        } else {
            v.to_string()
        }
    });
    // Engine-attested fields are recorded verbatim but stay pending: they are
    // the filing agent's own claims, exported for review — never verification.
    let evidence_pending = raw.verified.unwrap_or(false)
        || fix_verification.is_some()
        || raw.counterevidence.is_some()
        || raw.confidence_rationale.is_some()
        || !http_exchange_ids.is_empty()
        || evidence_context.is_some();
    Some(Finding {
        id: raw.id.unwrap_or_else(|| format!("finding-{}", uuid_v4())),
        severity,
        title,
        description: raw.description,
        file_path: raw.file_path,
        line_number: raw.line_number,
        status: raw.status.unwrap_or_else(|| "OPEN".to_string()),
        // Never persist the engine's `verified` claim — the only tier a local
        // run can produce is DETECTED.
        verified: false,
        verification_state: VERIFICATION_STATE_DETECTED.to_string(),
        evidence_pending,
        counterevidence: raw.counterevidence,
        confidence_rationale: raw.confidence_rationale,
        fix_verification,
        http_exchange_ids,
        evidence_context,
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

/// Whether a repo-form target string names a checked-out source tree on disk
/// rather than a remote Git remote.
fn is_checked_out_source(path: &str) -> bool {
    let trimmed = path.trim();
    if trimmed.starts_with('~') {
        return true;
    }
    std::path::Path::new(trimmed).is_dir()
}

/// Map the declared desktop target onto the engine's `--target-type` kind.
///
/// Engine target inference is offline-only, so a non-suffixed HTTP(S) Git
/// remote would otherwise classify as a web target. `None` keeps omission
/// semantics — the engine falls back to its offline inference. The flag only
/// classifies input; it never authorizes fetching the target.
fn engine_target_kind(target: &ScanTarget) -> Option<&'static str> {
    match target {
        ScanTarget::Url { .. } => Some("web_application"),
        ScanTarget::LocalPath { .. } => Some("local_code"),
        ScanTarget::Repo { path, .. } => {
            if is_checked_out_source(path) {
                Some("local_code")
            } else {
                // Remote refs — including bare host/path remotes the engine can
                // no longer probe — keep repository classification; the engine
                // validates the shape and errors actionably on a mismatch.
                Some("repository")
            }
        }
    }
}

/// Resolve a checked-out source path to absolute before launch. The engine
/// runs in a controlled per-scan workdir so `strix_runs/<run>` is locatable;
/// a relative target would silently scan the wrong directory without this.
fn resolve_local_target_arg(target: &ScanTarget) -> String {
    let raw = target.target_arg();
    let checked_out = match target {
        ScanTarget::LocalPath { .. } => true,
        ScanTarget::Repo { .. } => is_checked_out_source(&raw),
        ScanTarget::Url { .. } => false,
    };
    if !checked_out {
        return raw;
    }
    let path = std::path::Path::new(raw.trim_start_matches('~'));
    if path.is_absolute() {
        return raw;
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(&raw).to_string_lossy().to_string())
        .unwrap_or(raw)
}

/// Build the engine argv for a scan. Pure so target-kind mapping is testable.
fn build_engine_args(
    config: &ScanConfig,
    scan_id: &str,
    max_budget_usd: f64,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec![
        "--non-interactive".into(),
        "--run-name".into(),
        scan_id.to_string(),
        "--target".into(),
        resolve_local_target_arg(&config.target),
        "--scan-mode".into(),
        config.mode.engine_arg()?.into(),
        "--max-budget-usd".into(),
        max_budget_usd.to_string(),
    ];
    if let Some(kind) = engine_target_kind(&config.target) {
        args.push("--target-type".into());
        args.push(kind.into());
    }
    // Scope pinning mirrors the worker contract: Review Changes pins the
    // caller-selected comparison via --diff-base/--diff-head; every other
    // local run is an explicit full snapshot — never the engine's ambient
    // `auto` CI diff heuristic.
    match config.workflow {
        ScanWorkflow::ReviewChanges => {
            let base = config
                .diff_base
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .ok_or("Review Changes requires a base ref to compare against")?;
            args.push("--scope-mode".into());
            args.push("diff".into());
            args.push("--diff-base".into());
            args.push(validate_diff_ref(base)?.to_string());
            if let Some(head) = config
                .diff_head
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                args.push("--diff-head".into());
                args.push(validate_diff_ref(head)?.to_string());
            }
        }
        _ => {
            args.push("--scope-mode".into());
            args.push("full".into());
        }
    }
    if let Some(instruction) = &config.instruction {
        if !instruction.is_empty() {
            args.push("--instruction".into());
            args.push(instruction.clone());
        }
    }
    // A configured branch is only a fetch hint; a Review Changes run's
    // recorded refs own the checkout, so never also pin a branch there.
    if config.workflow != ScanWorkflow::ReviewChanges {
        if let ScanTarget::Repo { branch, .. } = &config.target {
            if let Some(b) = branch.as_ref().map(|b| b.trim()).filter(|b| !b.is_empty()) {
                args.push("--repository-branch".into());
                args.push(b.to_string());
            }
        }
    }
    Ok(args)
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
        &config.workflow,
        config.diff_base.as_deref(),
        config.diff_head.as_deref(),
    )
    .await?;
    // initial event seq 0: Started will be appended on start, but we ensure record exists
    Ok(())
}

pub async fn start_scan(app: AppHandle, config: ScanConfig) -> Result<String, String> {
    validate_max_budget_usd(config.max_budget_usd)?;
    // Depth/target contract is validated before any durable record or spawn:
    // a rejected launch must leave no pending scan behind.
    validate_launch(&config)?;
    let scan_id = config.scan_id.clone();
    // Durable identity BEFORE spawn — persistence failure prevents spawn
    create_scan_record(app.clone(), &config)
        .await
        .map_err(|e| format!("create_scan failed: {}", e))?;

    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let (finished_tx, finished_rx) = tokio::sync::watch::channel(None);
    // Register before returning the identity or scheduling execution.
    controls().lock().unwrap().insert(
        scan_id.clone(),
        ScanControl {
            cancel: cancel_tx,
            finished: finished_rx,
        },
    );
    tauri::async_runtime::spawn(async move {
        let runner_scan_id = config.scan_id.clone();
        let outcome = run_scan(app.clone(), config, cancel_rx).await;
        let (event, exit_code) = outcome.unwrap_or_else(|error| {
            (
                ScanEvent::Failed {
                    scan_id: runner_scan_id.clone(),
                    error,
                },
                Some(CrashCode::EngineCrash as i32),
            )
        });
        let result =
            crate::scan::store::persist_terminal(&app, &runner_scan_id, &event, exit_code).await;
        match &result {
            Ok(()) => {
                let name = match event {
                    ScanEvent::Completed { .. } => "scan://completed",
                    ScanEvent::Cancelled { .. } => "scan://cancelled",
                    _ => "scan://failed",
                };
                let _ = app.emit(name, &event);
            }
            Err(error) => {
                // A failed write is not a durable terminal state.
                let _ = app.emit(
                    "scan://error",
                    serde_json::json!({
                        "type": "error", "scan_id": runner_scan_id, "error": error,
                    }),
                );
            }
        }
        finished_tx.send_replace(Some(result));
        controls().lock().unwrap().remove(&runner_scan_id);
    });

    Ok(scan_id)
}

async fn run_scan(
    app: AppHandle,
    config: ScanConfig,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<(ScanEvent, Option<i32>), String> {
    let scan_id = config.scan_id.clone();
    if let Some(event) = cancelled_event(&scan_id, &cancel) {
        return Ok((event, Some(CrashCode::Cancelled as i32)));
    }

    // Resolve BYOK env for child only
    let byok_env = resolve_byok_env().map_err(|e| format!("BYOK missing: {}", e))?;

    // Mark running fail-closed
    crate::scan::store::mark_running(&app, &scan_id)
        .await
        .map_err(|e| format!("mark_running persistence failed: {}", e))?;
    if let Some(event) = cancelled_event(&scan_id, &cancel) {
        return Ok((event, Some(CrashCode::Cancelled as i32)));
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
    if let Some(event) = cancelled_event(&scan_id, &cancel) {
        return Ok((event, Some(CrashCode::Cancelled as i32)));
    }

    // Spawn engine with BYOK env only in child
    let engine_cmd = crate::runtime::resolve_engine_bin()?;

    let max_budget_usd = validate_max_budget_usd(config.max_budget_usd)?;
    // Re-check at spawn time so no call path can ever emit `--scan-mode url`
    // or a silently substituted tier.
    let args = build_engine_args(&config, &scan_id, max_budget_usd)?;

    // Controlled per-scan workdir: the engine writes strix_runs/<run-name>/
    // under its cwd, so a known dir makes the run contract (run.json) and the
    // finding projection (vulnerabilities.json) locatable for evidence
    // retention. Local target paths were absolutized in build_engine_args.
    let run_workdir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {}", e))?
        .join("runs")
        .join(&scan_id);
    std::fs::create_dir_all(&run_workdir)
        .map_err(|e| format!("create scan workdir failed: {}", e))?;

    let mut cmd = Command::new(engine_cmd);
    cmd.current_dir(&run_workdir);
    cmd.args(&args);
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
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
                let _ = stdout_kill.try_send(error.clone());
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
                    let _ = stdout_kill.try_send(error.clone());
                    persistence_error.get_or_insert(error);
                } else {
                    let _ = app_clone.emit("scan://finding", &finding_evt);
                }
                if let Err(error) = persist_finding_row(&app_clone, &scan_id_clone, &finding).await
                {
                    let _ = stdout_kill.try_send(error.clone());
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
            if let Err(error) =
                crate::scan::store::append_event(&app_clone2, &scan_id_clone2, cur, &progress).await
            {
                let _ = stderr_kill.try_send(error.clone());
                return Err(error);
            }
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

    let exit_status = wait_for_child(&mut child, &mut cancel, &mut kill_rx).await;
    if exit_status.is_err() {
        stdout_task.abort();
        stderr_task.abort();
    }
    // Drain both writers before the sole terminal transaction, including error paths.
    let stdout_result = stdout_task.await;
    let stderr_result = stderr_task.await;
    let exit_status = exit_status?;
    let findings = stdout_result.map_err(|error| format!("stdout task failed: {}", error))??;
    stderr_result.map_err(|error| format!("stderr task failed: {}", error))??;
    if let Some(event) = cancelled_event(&scan_id, &cancel) {
        return Ok((event, Some(CrashCode::Cancelled as i32)));
    }

    let exit_code = exit_status.code().unwrap_or(-1);
    let finding_count = findings.len();
    let is_success = exit_status.success() || exit_code == 2;

    crate::scan::store::set_finding_count(&app, &scan_id, finding_count).await?;

    // Evidence projection is best-effort: the run contract and richer
    // vulnerability fields are engine attestations recorded for later export
    // — never verification and never a reason to fail a completed scan.
    if is_success {
        project_engine_evidence(&app, &run_workdir, &scan_id, &findings).await;
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
    Ok((terminal_event, Some(exit_code)))
}

async fn persist_finding_row(app: &AppHandle, scan_id: &str, f: &Finding) -> Result<(), String> {
    crate::scan::store::persist_finding(app, scan_id, f).await
}

/// Best-effort projection of the engine run contract. Reads
/// `strix_runs/<scan_id>/run.json` (schema_version → scan.contract_version)
/// and `vulnerabilities.json` (richer evidence fields merged onto persisted
/// findings). Everything here is engine attestation: findings keep
/// `verification_state = DETECTED` and anything attested is marked
/// `evidence_pending` for export — this path can never promote or clear
/// verification state.
fn has_bound_threat_model(run_dir: &std::path::Path, run: &serde_json::Value) -> bool {
    let entry = &run["result_manifest"]["artifacts"]["threat_model.json"];
    if entry["path"].as_str() != Some("threat_model.json") {
        return false;
    }
    let Some(expected_bytes) = entry["bytes"].as_u64() else {
        return false;
    };
    if expected_bytes > 1_048_576 {
        return false;
    }
    let path = run_dir.join("threat_model.json");
    let Ok(metadata) = std::fs::symlink_metadata(&path) else {
        return false;
    };
    if !metadata.file_type().is_file() || metadata.len() != expected_bytes {
        return false;
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return false;
    };
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if bytes.len() as u64 != expected_bytes || entry["sha256"].as_str() != Some(digest.as_str()) {
        return false;
    }
    let Ok(document) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    document["schema_version"].as_str() == Some("lyrashield-threat-model/1.0")
        && document["run_id"] == run["run_id"]
        && document["models"].is_array()
}

async fn project_engine_evidence(
    app: &AppHandle,
    run_workdir: &std::path::Path,
    scan_id: &str,
    findings: &[Finding],
) {
    let run_dir = run_workdir.join("strix_runs").join(scan_id);
    let workdir = run_dir.clone();
    let scan_id_owned = scan_id.to_string();
    let parsed = tokio::task::spawn_blocking(
        move || -> Option<(String, serde_json::Value, Option<bool>)> {
            let run_json: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(workdir.join("run.json")).ok()?)
                    .ok()?;
            let schema_version = run_json
                .get("schema_version")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())?;
            let threat_available =
                (schema_version == "1.1").then(|| has_bound_threat_model(&workdir, &run_json));
            let vulns: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(workdir.join("vulnerabilities.json")).unwrap_or_default(),
            )
            .unwrap_or(serde_json::Value::Null);
            Some((schema_version, vulns, threat_available))
        },
    )
    .await;
    let Ok(Some((schema_version, vulns, threat_available))) = parsed else {
        return;
    };
    let _ =
        crate::scan::store::set_scan_contract_version(app, &scan_id_owned, &schema_version).await;
    if let Some(available) = threat_available {
        let _ = crate::scan::store::set_scan_threat_model_available(app, &scan_id_owned, available)
            .await;
    }
    let Some(reports) = vulns.as_array() else {
        return;
    };
    for report in reports {
        let Some(report) = report.as_object() else {
            continue;
        };
        let report_id = report.get("id").and_then(|v| v.as_str());
        let title = report.get("title").and_then(|v| v.as_str());
        // Match the persisted finding by engine id first, then by title —
        // stdout-parsed ids may differ from vuln-NNNN ids.
        let matched = findings.iter().find(|f| {
            report_id.is_some_and(|id| f.id == id) || title.is_some_and(|t| f.title == t)
        });
        let Some(finding) = matched else { continue };
        let string_field = |key: &str| -> Option<String> {
            report
                .get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        };
        let fix_verification = report.get("fix_verification").map(|v| {
            if let Some(s) = v.as_str() {
                s.to_string()
            } else {
                v.to_string()
            }
        });
        let http_exchange_ids = report
            .get("http_exchange_ids")
            .and_then(|v| serde_json::to_string(v).ok())
            .filter(|s| s != "null" && s != "[]");
        let engine_claimed = report
            .get("verified")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let update = crate::scan::store::FindingEvidenceUpdate {
            counterevidence: string_field("counterevidence"),
            confidence_rationale: string_field("confidence_rationale"),
            fix_verification,
            http_exchange_ids,
            evidence_context: bounded_evidence_context(report),
        };
        if update.counterevidence.is_some()
            || update.confidence_rationale.is_some()
            || update.fix_verification.is_some()
            || update.http_exchange_ids.is_some()
            || update.evidence_context.is_some()
            || engine_claimed
        {
            let _ = crate::scan::store::update_finding_evidence(
                app,
                &scan_id_owned,
                &finding.id,
                &update,
            )
            .await;
        }
    }
}

pub async fn cancel_scan(app: AppHandle, scan_id: String) -> Result<(), String> {
    let control = controls().lock().unwrap().get(&scan_id).cloned();
    if let Some(control) = control {
        return control.request_cancel().await;
    }
    let detail = crate::scan::store::get_scan_detail(&app, &scan_id).await?;
    match detail.status {
        ScanStatus::Completed | ScanStatus::Failed | ScanStatus::Cancelled => Ok(()),
        _ => Err(
            "No active scan owner; terminal state could not be confirmed. Reopen scan history."
                .into(),
        ),
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
    #[tokio::test]
    async fn cancellation_before_spawn_is_retained() {
        let (cancel, receiver) = tokio::sync::watch::channel(false);
        cancel.send_replace(true);
        for _ in 0..3 {
            assert!(matches!(
                super::cancelled_event("before-spawn", &receiver),
                Some(super::ScanEvent::Cancelled { .. })
            ));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_during_wait_is_prompt_idempotent_and_waits_for_persistence() {
        let mut child = tokio::process::Command::new("sleep")
            .arg("10")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (cancel, mut receiver) = tokio::sync::watch::channel(false);
        let (finished, completion) = tokio::sync::watch::channel(None);
        let control = super::ScanControl {
            cancel,
            finished: completion,
        };
        let (_kill, mut kill_rx) = tokio::sync::mpsc::channel(2);
        let owner = tokio::spawn(async move {
            let status = super::wait_for_child(&mut child, &mut receiver, &mut kill_rx)
                .await
                .unwrap();
            assert!(!status.success());
        });
        tokio::task::yield_now().await;
        let started = std::time::Instant::now();
        let first = tokio::spawn(control.clone().request_cancel());
        let second = tokio::spawn(control.clone().request_cancel());
        tokio::time::timeout(std::time::Duration::from_secs(2), owner)
            .await
            .unwrap()
            .unwrap();
        eprintln!("harmless child stopped in {:?}", started.elapsed());
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert!(
            !first.is_finished(),
            "cancel must await durable terminal confirmation"
        );
        assert!(!second.is_finished());
        finished.send_replace(Some(Ok(())));
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        control.request_cancel().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preexisting_cancel_and_output_failure_both_stop_child() {
        for cancel_first in [true, false] {
            let (cancel, mut receiver) = tokio::sync::watch::channel(cancel_first);
            let (kill, mut kill_rx) = tokio::sync::mpsc::channel(2);
            let mut child = tokio::process::Command::new("sleep")
                .arg("10")
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            if !cancel_first {
                kill.send("output persistence failed".into()).await.unwrap();
            }
            let status = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                super::wait_for_child(&mut child, &mut receiver, &mut kill_rx),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(!status.success());
            drop(cancel);
        }
    }

    #[tokio::test]
    async fn cancel_surfaces_persistence_failure_to_every_waiter() {
        let (cancel, _receiver) = tokio::sync::watch::channel(false);
        let (finished, completion) = tokio::sync::watch::channel(None);
        let control = super::ScanControl {
            cancel,
            finished: completion,
        };
        let waiter = tokio::spawn(control.clone().request_cancel());
        finished.send_replace(Some(Err("disk full".into())));
        assert_eq!(waiter.await.unwrap().unwrap_err(), "disk full");
        assert_eq!(control.request_cancel().await.unwrap_err(), "disk full");
    }

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

    fn launch_config(mode: ScanMode, target: ScanTarget) -> ScanConfig {
        ScanConfig {
            scan_id: "s".into(),
            target,
            mode,
            workflow: ScanWorkflow::ReviewTarget,
            diff_base: None,
            diff_head: None,
            instruction: None,
            max_budget_usd: 3.2,
        }
    }

    #[test]
    fn launch_validation_rejects_url_mode_before_spawn() {
        // A Url-mode launch must fail validation — no record, no spawn, no
        // silent tier substitution.
        let config = launch_config(
            ScanMode::Url,
            ScanTarget::LocalPath {
                path: "/tmp/x".into(),
            },
        );
        let err = super::validate_launch(&config).unwrap_err();
        assert!(err.contains("target kind"));
    }

    #[test]
    fn launch_validation_rejects_url_targets_without_local_transport() {
        // Hosted URL scans need domain verification + the scoped relay; Local
        // must refuse rather than quietly billing a BYOK AI run.
        for mode in [ScanMode::Quick, ScanMode::Standard, ScanMode::Deep] {
            let config = launch_config(
                mode,
                ScanTarget::Url {
                    url: "https://example.com".into(),
                },
            );
            assert!(super::validate_launch(&config).is_err());
        }
    }

    #[test]
    fn launch_validation_maps_legacy_aliases_to_canonical_depths() {
        let local = ScanTarget::LocalPath { path: "/x".into() };
        let cases = [
            (ScanMode::Safe, "quick"),
            (ScanMode::Quick, "quick"),
            (ScanMode::Standard, "standard"),
            (ScanMode::Deep, "deep"),
            (ScanMode::Custom, "deep"),
        ];
        for (mode, expected) in cases {
            let config = launch_config(mode, local.clone());
            assert_eq!(super::validate_launch(&config).unwrap(), expected);
        }
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

    fn args_for(target: ScanTarget) -> Vec<String> {
        let config = ScanConfig {
            scan_id: "scan-kind".into(),
            target,
            mode: ScanMode::Standard,
            workflow: ScanWorkflow::ReviewTarget,
            diff_base: None,
            diff_head: None,
            instruction: None,
            max_budget_usd: 3.2,
        };
        super::build_engine_args(&config, "scan-kind", 3.2).expect("test config has a valid depth")
    }

    fn flag_value(args: &[String], flag: &str) -> Option<String> {
        args.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
    }

    #[test]
    fn repo_remote_url_maps_to_repository_kind() {
        for remote in [
            "https://github.com/org/repo",
            "https://gitlab.com/org/repo.git",
            "git@github.com:org/repo.git",
            "git://git.example.com/org/repo",
            "github.com/org/repo",
        ] {
            let args = args_for(ScanTarget::Repo {
                path: remote.into(),
                branch: None,
            });
            assert_eq!(
                flag_value(&args, "--target-type").as_deref(),
                Some("repository"),
                "remote {remote} must classify as repository"
            );
        }
    }

    #[test]
    fn repo_checked_out_source_maps_to_local_code_kind() {
        let dir = std::env::temp_dir();
        let args = args_for(ScanTarget::Repo {
            path: dir.to_string_lossy().into_owned(),
            branch: None,
        });
        assert_eq!(
            flag_value(&args, "--target-type").as_deref(),
            Some("local_code")
        );

        let args = args_for(ScanTarget::Repo {
            path: "~/checked-out-repo".into(),
            branch: None,
        });
        assert_eq!(
            flag_value(&args, "--target-type").as_deref(),
            Some("local_code")
        );
    }

    #[test]
    fn url_and_local_path_targets_map_to_engine_kinds() {
        let url_args = args_for(ScanTarget::Url {
            url: "https://app.example.com".into(),
        });
        assert_eq!(
            flag_value(&url_args, "--target-type").as_deref(),
            Some("web_application")
        );

        let local_args = args_for(ScanTarget::LocalPath {
            path: "/tmp/source".into(),
        });
        assert_eq!(
            flag_value(&local_args, "--target-type").as_deref(),
            Some("local_code")
        );
    }

    #[test]
    fn repository_branch_arg_is_unchanged_with_kind_flag() {
        let args = args_for(ScanTarget::Repo {
            path: "https://github.com/org/repo".into(),
            branch: Some("release/2026.08".into()),
        });
        assert_eq!(
            flag_value(&args, "--repository-branch").as_deref(),
            Some("release/2026.08")
        );
        assert_eq!(
            flag_value(&args, "--target-type").as_deref(),
            Some("repository")
        );
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

    // Task 10 — workflow scope pins and the DETECTED-only evidence projection.
    // The shared fixture (packages/types/src/fixtures/scan-workflows.json) is
    // the cross-language source of truth these assertions mirror.

    fn workflow_fixture() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../../../packages/types/src/fixtures/scan-workflows.json"
        ))
        .expect("scan-workflows fixture parses")
    }

    #[test]
    fn fixture_review_changes_case_pins_diff_scope_and_refs() {
        // The fixture's recorded diff case (REPO target, base main, head
        // feature/42) must produce --scope-mode diff + --diff-base/--diff-head.
        let fixture = workflow_fixture();
        let case = fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"].as_str() == Some("repo review-changes diff"))
            .expect("fixture case exists");
        let request = &case["request"];
        assert_eq!(request["workflow"], "REVIEW_CHANGES");
        assert_eq!(case["expectedPlan"]["scope"], "DIFF");

        let mut config = launch_config(
            ScanMode::Quick,
            ScanTarget::Repo {
                path: "/repo".into(),
                branch: Some("main".into()),
            },
        );
        config.workflow = ScanWorkflow::ReviewChanges;
        config.diff_base = request["baseRef"].as_str().map(|s| s.to_string());
        config.diff_head = request["headRef"].as_str().map(|s| s.to_string());
        let args = super::build_engine_args(&config, "scan-x", 3.2).unwrap();
        assert_eq!(flag_value(&args, "--scope-mode").as_deref(), Some("diff"));
        assert_eq!(flag_value(&args, "--diff-base").as_deref(), Some("main"));
        assert_eq!(
            flag_value(&args, "--diff-head").as_deref(),
            Some("feature/42")
        );
        // A configured branch is only a fetch hint; recorded diff refs own
        // the checkout for a Review Changes run.
        assert!(flag_value(&args, "--repository-branch").is_none());
    }

    #[test]
    fn review_target_forces_full_scope_and_never_carries_refs() {
        let config = launch_config(ScanMode::Quick, ScanTarget::LocalPath { path: "/x".into() });
        let args = super::build_engine_args(&config, "scan-x", 3.2).unwrap();
        assert_eq!(flag_value(&args, "--scope-mode").as_deref(), Some("full"));
        assert!(flag_value(&args, "--diff-base").is_none());
        assert!(flag_value(&args, "--diff-head").is_none());

        // Diff refs without the workflow are rejected before any spawn.
        let mut bad = config.clone();
        bad.diff_base = Some("main".into());
        assert!(super::validate_launch(&bad).is_err());
    }

    #[test]
    fn review_changes_requires_base_and_a_checkout_target() {
        let mut config = launch_config(
            ScanMode::Standard,
            ScanTarget::Repo {
                path: "/repo".into(),
                branch: None,
            },
        );
        config.workflow = ScanWorkflow::ReviewChanges;
        assert!(
            super::validate_launch(&config).is_err(),
            "missing base ref must fail closed"
        );
        config.diff_base = Some("v1.0.0".into());
        assert!(super::validate_launch(&config).is_ok());
        // Refs that read as flags or range expressions are never argv values.
        config.diff_base = Some("--scope-mode".into());
        assert!(super::validate_launch(&config).is_err());
        config.diff_base = Some("main..other".into());
        assert!(super::validate_launch(&config).is_err());
        // URL targets have no local transport regardless of workflow.
        let mut url = launch_config(
            ScanMode::Quick,
            ScanTarget::Url {
                url: "https://example.com".into(),
            },
        );
        url.workflow = ScanWorkflow::ReviewChanges;
        url.diff_base = Some("main".into());
        assert!(super::validate_launch(&url).is_err());
    }

    #[test]
    fn engine_attestation_never_becomes_local_verification() {
        let finding = super::parse_finding_line(
            r#"{"id":"vuln-1","severity":"high","title":"X","verified":true,"fix_verification":{"outcome":"pass"},"http_exchange_ids":["ex-1"],"confidence_rationale":"reachable"}"#,
        )
        .expect("finding parses");
        // The engine's own `verified` claim is an attestation, not proof —
        // the persisted legacy flag stays false and the tier stays DETECTED.
        assert!(!finding.verified);
        assert_eq!(finding.verification_state, "DETECTED");
        assert!(finding.evidence_pending);
        assert_eq!(finding.confidence_rationale.as_deref(), Some("reachable"));
        assert!(finding.fix_verification.unwrap().contains("pass"));
        assert_eq!(finding.http_exchange_ids, vec!["ex-1".to_string()]);

        let plain = super::parse_finding_line(r#"{"id":"vuln-2","severity":"low","title":"Y"}"#)
            .expect("finding parses");
        assert!(!plain.evidence_pending);
        assert_eq!(plain.verification_state, "DETECTED");
    }

    #[test]
    fn engine_contextual_evidence_stays_structured_and_unverified() {
        let finding = super::parse_finding_line(
            r#"{"id":"vuln-3","severity":"high","title":"Z","contextual_cvss_reasoning":"Scope narrowed by authentication.","advisory_cvss":{"score":8.6,"vector":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/C:H/I:H/A:H"},"evidence_warnings":["No admin session"],"update_history":[{"timestamp":"2026-09-20T00:00:00Z","fields":["severity"],"reason":"Scope changed"}]}"#,
        )
        .expect("finding parses");
        let context = finding.evidence_context.expect("context preserved");
        assert_eq!(
            context.contextual_cvss_reasoning.as_deref(),
            Some("Scope narrowed by authentication.")
        );
        assert_eq!(context.advisory_cvss.unwrap()["score"], 8.6);
        assert_eq!(context.evidence_warnings, vec!["No admin session"]);
        assert_eq!(context.update_history.len(), 1);
        assert!(!finding.verified);
        assert_eq!(finding.verification_state, "DETECTED");
    }

    #[test]
    fn threat_model_availability_requires_manifest_bound_writer_bytes() {
        let run_dir = tempfile::tempdir().unwrap();
        let bytes = include_bytes!(
            "../../../../../apps/worker/src/engine/fixtures/run-json-1.1/threat_model.json"
        );
        std::fs::write(run_dir.path().join("threat_model.json"), bytes).unwrap();
        let run = serde_json::json!({
            "run_id": "fixture-run-1-1",
            "result_manifest": {"artifacts": {"threat_model.json": {
                "path": "threat_model.json",
                "bytes": bytes.len(),
                "sha256": format!("{:x}", sha2::Sha256::digest(bytes))
            }}}
        });
        assert!(super::has_bound_threat_model(run_dir.path(), &run));
        std::fs::write(run_dir.path().join("threat_model.json"), b"changed").unwrap();
        assert!(!super::has_bound_threat_model(run_dir.path(), &run));
    }

    #[test]
    fn workflow_tokens_match_the_shared_fixture() {
        let fixture = workflow_fixture();
        let workflows: Vec<&str> = fixture["workflows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w.as_str().unwrap())
            .collect();
        assert_eq!(
            workflows,
            [
                "REVIEW_TARGET",
                "REVIEW_CHANGES",
                "AUTHENTICATED_ASSESSMENT"
            ]
        );
        // The desktop's launchable set is a strict subset — AUTHENTICATED_
        // ASSESSMENT is hosted-only and Unknown never round-trips a launch.
        assert_eq!(ScanWorkflow::ReviewTarget.as_str(), "REVIEW_TARGET");
        assert_eq!(ScanWorkflow::ReviewChanges.as_str(), "REVIEW_CHANGES");
        assert!(ScanWorkflow::Unknown.as_str() != "AUTHENTICATED_ASSESSMENT");
        assert_eq!(
            ScanWorkflow::from_stored("AUTHENTICATED_ASSESSMENT"),
            ScanWorkflow::Unknown
        );
        // Verification tiers stay distinct in the contract.
        let tiers: Vec<&str> = fixture["verificationStatuses"]["trustTiers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap())
            .collect();
        assert_eq!(tiers, ["DETECTED", "VALIDATED", "VERIFIED"]);
        assert_eq!(VERIFICATION_STATE_DETECTED, "DETECTED");
    }
}
