use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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

fn bundled_engine_candidates(executable: &Path) -> Result<Vec<PathBuf>, String> {
    let directory = executable
        .parent()
        .ok_or_else(|| "cannot locate app bundle directory".to_string())?;
    let names: &[&str] = if cfg!(target_os = "windows") {
        &[
            "lyrashield-engine.exe",
            "lyrashield-engine-x86_64-pc-windows-msvc.exe",
            "lyrashield-engine-aarch64-pc-windows-msvc.exe",
        ]
    } else if cfg!(target_os = "macos") {
        &[
            "lyrashield-engine",
            "lyrashield-engine-aarch64-apple-darwin",
            "lyrashield-engine-x86_64-apple-darwin",
        ]
    } else {
        &[
            "lyrashield-engine",
            "lyrashield-engine-x86_64-unknown-linux-gnu",
            "lyrashield-engine-aarch64-unknown-linux-gnu",
        ]
    };
    let roots = [
        directory.to_path_buf(),
        directory.join("binaries"),
        directory.join("../Resources"),
        directory.join("../Resources/binaries"),
    ];
    Ok(roots
        .iter()
        .flat_map(|root| names.iter().map(|name| root.join(name)))
        .collect())
}

/// Resolve the engine executable. Release builds require the bundled sidecar;
/// debug builds may use an explicit override or a developer PATH install.
pub fn resolve_engine_bin() -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("LYRASHIELD_ENGINE_BIN") {
            if !path.is_empty() {
                return Ok(PathBuf::from(path));
            }
        }
        for command in ["lyrashield", "strix"] {
            if let Ok(path) = which::which(command) {
                return Ok(path);
            }
        }
    }

    let executable =
        std::env::current_exe().map_err(|error| format!("cannot locate app bundle: {error}"))?;
    bundled_engine_candidates(&executable)?
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            "bundled LyraShield engine not found; reinstall LyraShield Local".to_string()
        })
}

/// Detect the resolved LyraShield engine and parse its version output.
pub fn detect_engine() -> EngineInfo {
    if let Ok(path) = resolve_engine_bin() {
        let version = Command::new(&path)
            .arg("--version")
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|version| version.trim().to_string());
        return EngineInfo {
            found: true,
            path: Some(path.to_string_lossy().to_string()),
            version,
        };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_candidates_never_include_global_commands() {
        let candidates =
            bundled_engine_candidates(Path::new("/Applications/LyraShield.app/MacOS/app")).unwrap();
        assert!(!candidates.is_empty());
        assert!(candidates.iter().all(|candidate| candidate.is_absolute()));
        assert!(candidates
            .iter()
            .all(|candidate| candidate.to_string_lossy().contains("lyrashield-engine")));
    }
}
