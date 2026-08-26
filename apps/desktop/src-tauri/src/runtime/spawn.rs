use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::process::Command;

const INHERITED_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];

fn filter_runtime_env<I>(vars: I) -> Vec<(OsString, OsString)>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    vars.into_iter()
        .filter(|(key, _)| {
            INHERITED_ENV_ALLOWLIST
                .iter()
                .any(|allowed| key == OsStr::new(allowed))
        })
        .collect()
}

/// Return the minimal parent environment needed to locate the engine and its local runtime.
pub fn inherited_runtime_env() -> Vec<(OsString, OsString)> {
    filter_runtime_env(std::env::vars_os())
}

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
    cmd.env_clear();
    cmd.envs(inherited_runtime_env());
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

#[cfg(test)]
mod tests {
    use super::filter_runtime_env;
    use std::ffi::OsString;

    #[test]
    fn runtime_environment_excludes_unrelated_secrets() {
        let filtered = filter_runtime_env([
            (OsString::from("PATH"), OsString::from("/usr/bin")),
            (
                OsString::from("ALL_PROXY"),
                OsString::from("socks5://127.0.0.1:1080"),
            ),
            (
                OsString::from("UNRELATED_PROVIDER_SECRET"),
                OsString::from("should-not-leak"),
            ),
        ]);

        assert_eq!(
            filtered,
            vec![
                (OsString::from("PATH"), OsString::from("/usr/bin")),
                (
                    OsString::from("ALL_PROXY"),
                    OsString::from("socks5://127.0.0.1:1080"),
                ),
            ]
        );
    }
}
