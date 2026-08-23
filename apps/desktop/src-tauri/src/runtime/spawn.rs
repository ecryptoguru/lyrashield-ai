use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;

/// Result of running a command to completion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

/// Run an engine command to completion, capturing output.
///
/// Used for non-interactive commands like `auth status` and `--version`.
pub fn run_engine_command(args: &[String], env: &HashMap<String, String>) -> CommandResult {
    let engine = match super::resolve_engine_bin() {
        Ok(engine) => engine,
        Err(error) => {
            return CommandResult {
                success: false,
                stdout: String::new(),
                stderr: error,
                exit_code: None,
            }
        }
    };

    let mut cmd = Command::new(engine);
    cmd.args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }

    match cmd.output() {
        Ok(output) => CommandResult {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code(),
        },
        Err(e) => CommandResult {
            success: false,
            stdout: String::new(),
            stderr: format!("failed to spawn engine: {}", e),
            exit_code: None,
        },
    }
}
