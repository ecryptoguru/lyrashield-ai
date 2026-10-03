import type { AgentEntry } from "../types"
import { API_URL_PLACEHOLDER, LAST_AGENT_REGISTRY_CHECK_DATE } from "./shared"

export const opencode: AgentEntry = {
  id: "opencode",
  displayName: "OpenCode",
  productFamily: { id: "opencode", name: "OpenCode" },
  surface: "cli",
  nativeCapabilities: ["skills"],
  skillLocations: [
    { scope: "project", path: ".opencode/skills", sharedByConvention: true },
    { scope: "global", path: "~/.config/opencode/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "OpenCode native skill discovery",
    url: "https://opencode.ai/docs/skills",
    state: "DIRECT",
  },
  docsSlug: "opencode",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcp",
  locations: [
    {
      scope: "global",
      path: "~/.config/opencode/opencode.json",
      sharedByConvention: false,
    },
    {
      scope: "project",
      path: "opencode.json",
      sharedByConvention: true,
    },
  ],
  transports: ["stdio", "remote-http"],
  remoteAuth: "oauth",
  credential: {
    kind: "interpolated-env",
    syntax: "{env:LYRASHIELD_API_KEY}",
  },
  transportFields: {
    stdio: { type: "local" },
    "remote-http": { type: "remote", url: API_URL_PLACEHOLDER },
  },
  stdioStyle: "array-command-environment",
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://opencode.ai/docs/mcp-servers/",
  },
  gotchas: [
    "OpenCode's global config is `~/.config/opencode/opencode.json`; project `opencode.json` overrides it.",
    "OpenCode uses single-brace `{env:VAR}` syntax, not `${VAR}`; wrong syntax passes the literal string through.",
    'OpenCode local entries use `type: "local"`, a command array and `environment`; remote entries use `type: "remote"`.',
    "OpenCode stores servers under the top-level `mcp` object and uses `enabled: false` to disable an entry.",
  ],
}

export const opencodeV2: AgentEntry = {
  id: "opencode-v2",
  displayName: "OpenCode V2",
  productFamily: { id: "opencode", name: "OpenCode" },
  surface: "cli",
  versionConstraints: {
    minimum: "2",
    note: "V2 places MCP servers under mcp.servers; the stable V1 renderer uses the former mcp root map.",
  },
  docsSlug: "opencode-v2",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio", "remote-http"],
  preferredTransport: "remote-http",
  remoteAuth: "oauth",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["skills"],
  skillLocations: [
    { scope: "project", path: ".opencode/skills", sharedByConvention: true },
    { scope: "global", path: "~/.config/opencode/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "OpenCode V2 skills and MCP configuration",
    url: "https://opencode.ai/v2/docs/mcp-servers",
    state: "DIRECT",
  },
  manualInstructions:
    "For V2, add LyraShield with opencode mcp add lyrashield --url https://app.lyrashieldai.com/api/mcp and complete OAuth with opencode mcp auth lyrashield. If editing JSON manually, put the entry under mcp.servers.lyrashield; V2 uses type remote for HTTP and type local for stdio. The native skill locations remain .opencode/skills and ~/.config/opencode/skills.",
  rulesFiles: ["AGENTS.md"],
  source: { checkedOn: "2026-10-01", url: "https://opencode.ai/v2/docs/mcp-servers" },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://opencode.ai/v2/docs/mcp-servers",
    receipt: null,
  },
  gotchas: [
    "OpenCode V2 uses mcp.servers and a nested per-server object; the stable OpenCode entry represents V1 mcp root and is not interchangeable.",
    "V2 MCP remote connections use OAuth by default and can be authorized through opencode mcp auth lyrashield; do not add a bearer header when using OAuth.",
    "V2 skill discovery still uses .opencode/skills and ~/.config/opencode/skills and is compatible with the portable Agent Skills layout.",
  ],
}
