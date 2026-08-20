use serde::{Deserialize, Serialize};
use std::process::Command;

/// Information about the installed LyraShield engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineInfo {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

/// Information about the Docker runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerInfo {
    pub found: bool,
    pub running: bool,
    pub version: Option<String>,
}

/// Combined runtime status for the setup screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeStatus {
    pub engine: EngineInfo,
    pub docker: DockerInfo,
}

/// Detect the LyraShield engine on PATH.
///
/// Looks for `lyrashield` first, then `strix` (the upstream CLI name).
/// Parses `--version` output to get the version string.
pub fn detect_engine() -> EngineInfo {
    for cmd in &["lyrashield", "strix"] {
        if let Ok(path) = which::which(cmd) {
            let version = Command::new(cmd)
                .arg("--version")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string());

            return EngineInfo {
                found: true,
                path: Some(path.to_string_lossy().to_string()),
                version,
            };
        }
    }

    EngineInfo {
        found: false,
        path: None,
        version: None,
    }
}

/// Detect Docker and check if the daemon is running.
pub fn detect_docker() -> DockerInfo {
    if which::which("docker").is_err() {
        return DockerInfo {
            found: false,
            running: false,
            version: None,
        };
    }

    let version = Command::new("docker")
        .args(["--version"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string());

    // `docker info` succeeds only when the daemon is running.
    let running = Command::new("docker")
        .args(["info"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    DockerInfo {
        found: true,
        running,
        version,
    }
}

/// Get the combined runtime status (engine + Docker).
pub fn get_runtime_status() -> RuntimeStatus {
    RuntimeStatus {
        engine: detect_engine(),
        docker: detect_docker(),
    }
}
