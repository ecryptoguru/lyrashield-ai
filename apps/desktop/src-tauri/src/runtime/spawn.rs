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

/// Provider/model routing variables that must never reach the engine child
/// from the parent environment — the desktop resolves the selected provider's
/// route explicitly per scan (`byok::resolve_byok_env`), and a stale inherited
/// `LYRASHIELD_LLM`/`OPENAI_API_KEY`/`AZURE_*` must not shadow it.
pub const PROVIDER_MODEL_ENV_NAMES: &[&str] = &[
    "LYRASHIELD_LLM",
    "LYRASHIELD_LUNA_LLM",
    "LYRASHIELD_SOL_LLM",
    "LYRASHIELD_DELEGATE_LLM",
    "LYRASHIELD_REASONING_EFFORT",
    "LYRASHIELD_DELEGATE_REASONING_EFFORT",
    "LYRASHIELD_ALLOW_CHATGPT_SUBSCRIPTION",
    "LYRASHIELD_PROGRAMMATIC_TOOL_CALLING",
    "LLM_API_KEY",
    "LLM_API_BASE",
    "LLM_API_VERSION",
    "LLM_TIMEOUT",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_BASE",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_AI_API_KEY",
    "AZURE_AI_API_BASE",
    "AZURE_API_VERSION",
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

/// Remove provider/model routing variables from an inherited environment.
/// `env_clear` plus the allowlist already exclude them; this second filter
/// keeps that guarantee if the allowlist ever grows to include one.
pub fn strip_provider_model_env<I>(vars: I) -> Vec<(OsString, OsString)>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    vars.into_iter()
        .filter(|(key, _)| {
            !PROVIDER_MODEL_ENV_NAMES
                .iter()
                .any(|blocked| key == OsStr::new(blocked))
        })
        .collect()
}

/// Return the minimal parent environment needed to locate the engine and its
/// local runtime — never any stale provider/model routing variables.
pub fn inherited_runtime_env() -> Vec<(OsString, OsString)> {
    strip_provider_model_env(filter_runtime_env(std::env::vars_os()))
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
    use super::{filter_runtime_env, strip_provider_model_env};
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

    #[test]
    fn stale_provider_and_model_vars_are_stripped() {
        // Every model/provider routing name is removed even if it were
        // somehow present in the inherited set — the per-scan resolver owns
        // these variables now.
        let mut vars: Vec<(OsString, OsString)> = super::PROVIDER_MODEL_ENV_NAMES
            .iter()
            .map(|name| (OsString::from(name), OsString::from("stale")))
            .collect();
        vars.push((OsString::from("PATH"), OsString::from("/usr/bin")));

        let stripped = strip_provider_model_env(vars);
        assert_eq!(
            stripped,
            vec![(OsString::from("PATH"), OsString::from("/usr/bin"))]
        );
        assert!(stripped
            .iter()
            .all(|(k, _)| !super::PROVIDER_MODEL_ENV_NAMES
                .iter()
                .any(|n| k == &OsString::from(n))));
    }

    #[test]
    fn provider_model_names_are_not_inherited_allowlist() {
        // Guard the invariant directly: no routing variable may sit on the
        // allowlist, or it would be inherited before the resolver overlay.
        for name in super::PROVIDER_MODEL_ENV_NAMES {
            assert!(
                !super::INHERITED_ENV_ALLOWLIST.contains(name),
                "{name} must never be an inherited runtime env"
            );
        }
    }
}
