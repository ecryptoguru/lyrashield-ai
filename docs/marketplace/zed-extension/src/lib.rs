use zed_extension_api::{self as zed, ContextServerId, Project};

struct LyraShield;

impl zed::Extension for LyraShield {
    fn new() -> Self {
        Self
    }

    fn context_server_command(
        &mut self,
        _context_server_id: &ContextServerId,
        _project: &Project,
    ) -> zed::Result<zed::Command> {
        // OAuth is initiated by `lyrashield login --oauth`; the MCP process
        // then consumes the short-lived credential from the shared store.
        Ok(zed::Command {
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "@lyrashield/mcp".to_string()],
            env: vec![(
                "LYRASHIELD_API_URL".to_string(),
                "https://app.lyrashieldai.com".to_string(),
            )],
        })
    }
}

zed::register_extension!(LyraShield);
