use schemars::JsonSchema;
use serde::Deserialize;
use zed::settings::ContextServerSettings;
use zed_extension_api::{
    self as zed, serde_json, Command, ContextServerConfiguration, ContextServerId, Project, Result,
};

const PACKAGE_NAME: &str = "@lyrashield/mcp";
const PACKAGE_VERSION: &str = "0.2.2";
const SERVER_ENTRYPOINT: &str = "node_modules/@lyrashield/mcp/dist/stdio-transport.js";
const EXTENSION_CRED_ENV_VAR: &str = "LYRASHIELD_EXTENSION_CRED";

#[derive(Debug, Deserialize, JsonSchema)]
struct LyraShieldMcpSettings {
    /// Optional LyraShield workspace API key for CI or non-OAuth environments.
    #[serde(default)]
    api_key: Option<String>,
}

struct LyraShieldMcpExtension;

impl LyraShieldMcpExtension {
    fn settings_error(context_server_id: &ContextServerId, reason: &str) -> String {
        format!(
            "{reason}\n\n\
             Recommended: run `lyrashield login --oauth` once in a terminal, then restart Zed.\n\n\
             API-key fallback settings:\n\n\
             {{\n  \
                 \"context_servers\": {{\n    \
                     \"{context_server_id}\": {{\n      \
                         \"settings\": {{\n        \
                             \"api_key\": \"lsk_…\"\n        \
                         }}\n    \
                     }}\n  \
                 }}\n\
             }}\n\n\
             Get your key at https://app.lyrashieldai.com/dashboard/settings"
        )
    }
}

impl zed::Extension for LyraShieldMcpExtension {
    fn new() -> Self {
        Self
    }

    fn context_server_command(
        &mut self,
        context_server_id: &ContextServerId,
        project: &Project,
    ) -> Result<Command> {
        let settings = ContextServerSettings::for_project(context_server_id.as_ref(), project)?;

        let settings: LyraShieldMcpSettings = match settings.settings {
            Some(settings) => serde_json::from_value(settings).map_err(|err| {
                Self::settings_error(
                    context_server_id,
                    &format!("Invalid settings for the LyraShield MCP server: {err}."),
                )
            })?,
            None => LyraShieldMcpSettings { api_key: None },
        };

        let installed_version = zed::npm_package_installed_version(PACKAGE_NAME)?;

        if installed_version.as_deref() != Some(PACKAGE_VERSION) {
            zed::npm_install_package(PACKAGE_NAME, PACKAGE_VERSION)?;
        }

        let node = zed::node_binary_path()?;

        let entrypoint = std::env::current_dir()
            .map_err(|err| format!("Failed to resolve the extension working directory: {err}"))?
            .join(SERVER_ENTRYPOINT);

        let api_key = settings.api_key.unwrap_or_default();
        let command = Command {
            command: node,
            args: vec![
                "--eval".to_string(),
                format!(
                    "{}\nimport(require('node:url').pathToFileURL(process.argv[1]).href)",
                    include_str!("../mcp-env.cjs")
                ),
                entrypoint.to_string_lossy().to_string(),
            ],
            env: vec![(EXTENSION_CRED_ENV_VAR.to_string(), api_key)],
        };
        Ok(command)
    }

    fn context_server_configuration(
        &mut self,
        _context_server_id: &ContextServerId,
        _project: &Project,
    ) -> Result<Option<ContextServerConfiguration>> {
        let installation_instructions =
            include_str!("../configuration/installation_instructions.md").to_string();
        let default_settings = include_str!("../configuration/default_settings.jsonc").to_string();
        let settings_schema = serde_json::to_string(&schemars::schema_for!(LyraShieldMcpSettings))
            .map_err(|err| format!("Failed to serialize the settings schema: {err}"))?;

        Ok(Some(ContextServerConfiguration {
            installation_instructions,
            default_settings,
            settings_schema,
        }))
    }
}

zed::register_extension!(LyraShieldMcpExtension);
