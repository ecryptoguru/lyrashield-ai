use crate::scan::types::*;
use serde::Deserialize;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Parse a single engine output line into a finding (if it matches the JSON format).
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

/// Start a scan by spawning the engine process and streaming events to the frontend.
///
/// Uses structured process arguments — no shell string — to prevent injection.
/// Streams stdout/stderr as Progress events, parsed findings as Finding events,
/// and a terminal Completed/Failed/Cancelled event.
pub async fn start_scan(app: AppHandle, config: ScanConfig) -> Result<String, String> {
    let scan_id = config.scan_id.clone();

    let engine_cmd = if which::which("lyrashield").is_ok() {
        "lyrashield"
    } else if which::which("strix").is_ok() {
        "strix"
    } else {
        return Err("LyraShield engine not found on PATH".to_string());
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

    let mut child = Command::new(engine_cmd)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn engine: {}", e))?;

    let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture stderr")?;

    let app_clone = app.clone();
    let scan_id_clone = scan_id.clone();
    let stdout_task = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut findings: Vec<Finding> = Vec::new();

        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_clone.emit(
                "scan://progress",
                ScanEvent::Progress {
                    scan_id: scan_id_clone.clone(),
                    line: line.clone(),
                    stream: "stdout".into(),
                },
            );

            if let Some(finding) = parse_finding_line(&line) {
                let _ = app_clone.emit(
                    "scan://finding",
                    ScanEvent::Finding {
                        scan_id: scan_id_clone.clone(),
                        finding: finding.clone(),
                    },
                );
                findings.push(finding);
            }
        }

        findings
    });

    let app_clone2 = app.clone();
    let scan_id_clone2 = scan_id.clone();
    let stderr_task = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_clone2.emit(
                "scan://progress",
                ScanEvent::Progress {
                    scan_id: scan_id_clone2.clone(),
                    line,
                    stream: "stderr".into(),
                },
            );
        }
    });

    let _ = app.emit(
        "scan://started",
        ScanEvent::Started {
            scan_id: scan_id.clone(),
        },
    );

    let status = child
        .wait()
        .await
        .map_err(|e| format!("engine wait failed: {}", e))?;
    let findings = stdout_task.await.unwrap_or_default();
    let _ = stderr_task.await;

    let exit_code = status.code().unwrap_or(-1);
    let finding_count = findings.len();

    if status.success() || exit_code == 2 {
        let _ = app.emit(
            "scan://completed",
            ScanEvent::Completed {
                scan_id: scan_id.clone(),
                exit_code,
                finding_count,
            },
        );
    } else {
        let _ = app.emit(
            "scan://failed",
            ScanEvent::Failed {
                scan_id: scan_id.clone(),
                error: format!("Engine exited with code {}", exit_code),
            },
        );
    }

    let _ = crate::scan::store::save_scan_result(
        &scan_id,
        &config.target.target_arg(),
        &config.mode,
        if status.success() || exit_code == 2 {
            ScanStatus::Completed
        } else {
            ScanStatus::Failed
        },
        &findings,
    )
    .await;

    Ok(scan_id)
}

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:032x}", now)
}
