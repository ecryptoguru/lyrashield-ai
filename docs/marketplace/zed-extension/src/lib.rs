use schemars::JsonSchema;
use serde::Deserialize;
use zed::settings::ContextServerSettings;
use zed_extension_api::{
    self as zed, serde_json, Command, ContextServerConfiguration, ContextServerId, Project, Result,
};

const PACKAGE_NAME: &str = "@lyrashield/mcp";
const SERVER_ENTRYPOINT: &str = "node_modules/@lyrashield/mcp/dist/stdio-transport.js";
const API_KEY_ENV_VAR: &str = "LYRASHIELD_API_KEY";
const API_URL_ENV_VAR: &str = "LYRASHIELD_API_URL";
const DEFAULT_API_URL: &str = "https://app.lyrashieldai.com";

#[derive(Debug, Deserialize, JsonSchema)]
struct LyraShieldMcpSettings {
    /// Optional LyraShield workspace API key for CI or non-OAuth environments.
    #[serde(default)]
    api_key: Option<String>,
    /// The LyraShield app URL. Defaults to https://app.lyrashieldai.com.
    #[serde(default = "default_api_url")]
    api_url: String,
}

fn default_api_url() -> String {
    DEFAULT_API_URL.to_string()
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
                             \"api_key\": \"lsk_…\",\n        \
                             \"api_url\": \"https://app.lyrashieldai.com\"\n      \
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

        let settings: LyraShieldMcpSettings = settings.settings.map_or_else(
            || Ok(LyraShieldMcpSettings { api_key: None, api_url: default_api_url() }),
            |settings| serde_json::from_value(settings).map_err(|err| {
            Self::settings_error(
                context_server_id,
                &format!("Invalid settings for the LyraShield MCP server: {err}."),
            )
        }),
        )?;

        let api_url = settings.api_url.trim().to_string();
        let api_url = if api_url.is_empty() {
            DEFAULT_API_URL.to_string()
        } else {
            api_url
        };

        let latest_version = zed::npm_package_latest_version(PACKAGE_NAME)?;
        let installed_version = zed::npm_package_installed_version(PACKAGE_NAME)?;

        if installed_version.as_deref() != Some(latest_version.as_str()) {
            zed::npm_install_package(PACKAGE_NAME, &latest_version)?;
        }

        let node = zed::node_binary_path()?;

        let entrypoint = std::env::current_dir()
            .map_err(|err| format!("Failed to resolve the extension working directory: {err}"))?
            .join(SERVER_ENTRYPOINT);

        let mut command = Command {
            command: node,
            args: vec![entrypoint.to_string_lossy().to_string()],
            env: vec![(API_URL_ENV_VAR.to_string(), api_url)],
        };
        if let Some(api_key) = settings.api_key.map(|key| key.trim().to_string()).filter(|key| !key.is_empty()) {
            command.env.push((API_KEY_ENV_VAR.to_string(), api_key));
        }
        Ok(command)
    }

    fn context_server_configuration(
        &mut self,
        _context_server_id: &ContextServerId,
        _project: &Project,
    ) -> Result<Option<ContextServerConfiguration>> {
        let installation_instructions =
            include_str!("../configuration/installation_instructions.md").to_string();
        let default_settings =
            include_str!("../configuration/default_settings.jsonc").to_string();
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
