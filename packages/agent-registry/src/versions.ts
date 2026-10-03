import type { AgentEntry } from "./types"

/** Exact MCP runtime pin for the coordinated native-agent release. */
export const MCP_PACKAGE_VERSION = "0.2.12"
export const MCP_PACKAGE_SPEC = `@lyrashield/mcp@${MCP_PACKAGE_VERSION}`

/** Exact CLI pin for the coordinated native-agent release. */
export const CLI_PACKAGE_VERSION = "0.2.14"
export const CLI_PACKAGE_SPEC = `lyrashield@${CLI_PACKAGE_VERSION}`

/** The pinned release includes the native skills installer. */
export const CLI_SKILLS_AVAILABLE = true

/** The pinned release includes the safe atomic configuration writer. */
export const CLI_CONFIG_WRITES_AVAILABLE = true

/**
 * Install-contract fingerprints extracted from the published `lyrashield@0.2.13`
 * npm tarball (integrity: sha512-M6SvchlRtmYJnQuYmNOFhXIfnjgeUcuhDZTlLlMHR5NFTLfoM0wNUE6J8Sw7fDUZinvJ3KS3ElzFnqAJkjOY5g==).
 * CLI 0.2.14 uses this baseline as a drift guard for unchanged client contracts;
 * new or changed contracts remain gated. The safe writer and skills installer
 * are separate release features, and the exact packed artifact must be verified.
 * Each fingerprint covers the serialized fields that control CLI installation:
 * identity/aliases, strategy, paths and formats, transports, credential shape,
 * vendor command, plugin paths, manual setup text and rules files. This is a
 * compatibility drift guard, not a security boundary.
 */
const PUBLISHED_CLI_INSTALL_CONTRACTS: Readonly<Record<string, string>> = {
  "claude-code": "107a96b778da5d03",
  cursor: "2c27967e71b64e0a",
  devin: "451508b895a55604",
  vscode: "07ef91669e6b52b2",
  "openai-codex": "283b5376fa2a6e1a",
  cline: "9e9a89743516fcb8",
  opencode: "7d0128a023489a24",
  "kilo-code": "cd5b0d0b9827a417",
  zed: "f9bba83a347bfbf6",
  "gemini-cli": "affda5982f289fdc",
  jetbrains: "0bef69a408ae9868",
  amp: "9ea8f16635a46af2",
  picode: "b1b9f2731011654f",
  openclaw: "9f1dbbbf5b2eefeb",
  hermes: "3703126eb469b6da",
  antigravity: "d61477ede26b0399",
  "copilot-cli": "7f5e4c40d5acb634",
  goose: "da95ddc94977c4a5",
  aider: "0138327651149afa",
  "devin-cli": "342bb0f4face1050",
  "roo-code": "ac00ec0fdc56b1f3",
  "mimo-code": "69ab075d0d12e6d1",
  codebuff: "9aea1551eaf99a95",
  "oh-my-pi": "eaa1fc4e84eaa252",
  "claude-code-agent-plugin": "96ff4d454baded31",
  "cursor-agent-plugin": "cae99e06b62b8ba2",
  "vscode-agent-plugin": "a18cbfb718db039b",
  "openai-codex-agent-plugin": "cc85fed0edbd89ac",
  "github-copilot-agent-plugin": "8bf76425aad49e69",
  "kiro-agent-plugin": "cda11f445bd19558",
}

// The published CLI redirects these base client IDs to their plugin entries.
// A legacy/config snippet for the base ID must therefore stay manual, even
// though an explicit preferred plugin entry may be installable.
const PUBLISHED_CLI_PREFERRED_INSTALL_TARGETS: Readonly<Record<string, string>> = {
  "claude-code": "claude-code-agent-plugin",
  cursor: "cursor-agent-plugin",
  "openai-codex": "openai-codex-agent-plugin",
  "github-copilot": "github-copilot-agent-plugin",
  kiro: "kiro-agent-plugin",
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return Object.fromEntries(entries.map(([key, item]) => [key, stableValue(item)]))
  }
  return value
}

function installContractFingerprint(agent: AgentEntry): string {
  const contract = stableValue({
    id: agent.id,
    aliases: agent.aliases ?? null,
    installStrategy: agent.installStrategy,
    format: agent.format,
    rootKey: agent.rootKey,
    locations: agent.locations,
    transports: agent.transports,
    integrationKind: agent.integrationKind ?? null,
    preferredTransport: agent.preferredTransport ?? null,
    remoteAuth: agent.remoteAuth ?? null,
    ...(agent.remoteAuthConfig ? { remoteAuthConfig: agent.remoteAuthConfig } : {}),
    credential: agent.credential,
    requiredEntryFields: agent.requiredEntryFields ?? null,
    transportFields: agent.transportFields ?? null,
    commandWrapperKey: agent.commandWrapperKey ?? null,
    stdioStyle: agent.stdioStyle ?? null,
    vendorCli: agent.vendorCli ?? null,
    pluginLocations: agent.pluginLocations ?? null,
    manualInstructions: agent.manualInstructions ?? null,
    serverNamePattern: agent.serverNamePattern ?? null,
    rulesFiles: agent.rulesFiles,
  })
  const serialized = JSON.stringify(contract)
  let first = 0x811c9dc5
  let second = 0x9e3779b9

  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }

  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`
}

/** Return a pinned published CLI command only when its full install contract matches. */
export function getPublishedCliInstallCommand(agent: AgentEntry): string | null {
  if (agent.installStrategy === "config-file" && !CLI_CONFIG_WRITES_AVAILABLE) return null

  const preferredTarget = PUBLISHED_CLI_PREFERRED_INSTALL_TARGETS[agent.id]
  if (preferredTarget && preferredTarget !== agent.id) return null

  const publishedContract = PUBLISHED_CLI_INSTALL_CONTRACTS[agent.id]
  if (!publishedContract || installContractFingerprint(agent) !== publishedContract) return null

  return `npx -y ${CLI_PACKAGE_SPEC} install ${agent.id}`
}
