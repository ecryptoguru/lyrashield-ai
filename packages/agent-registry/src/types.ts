export type ConfigFormat = "json" | "jsonc" | "toml" | "yaml"
export type InstallStrategy = "config-file" | "vendor-cli" | "guided-manual" | "agent-plugin"
export type Transport = "stdio" | "remote-http"

export type CredentialStyle =
  | { kind: "inline-env" }
  | { kind: "interpolated-env"; syntax: string }
  | { kind: "env-names"; field: string }
  | { kind: "shell-env" }
  | { kind: "http-header"; header: string }
  | { kind: "ui-fields" }

export interface ConfigLocation {
  scope: "project" | "global"
  path: string
  platform?: Partial<Record<"darwin" | "linux" | "win32", string>>
  sharedByConvention: boolean
}

export interface AgentEntry {
  id: string
  displayName: string
  docsSlug: string
  installStrategy: InstallStrategy
  format: ConfigFormat | null
  rootKey: string | null
  locations: ConfigLocation[]
  transports: Transport[]
  credential: CredentialStyle
  requiredEntryFields?: Record<string, string>
  /** Per-transport fields. Use "<apiUrl>" as a placeholder; stdio env blocks receive the base apiUrl, remote HTTP entries receive the MCP endpoint. */
  transportFields?: Partial<Record<Transport, Record<string, string>>>
  commandWrapperKey?: string | null
  /**
   * Stdio entry shape override for agents whose local MCP config does not use the
   * standard `{command, args, env}` triple. "array-command-environment" renders
   * `{type, command: string[], environment: env, enabled: true}` (MiMo Code).
   */
  stdioStyle?: "array-command-environment"
  vendorCli?: { command: string; args: string[] }
  rulesFiles: string[]
  forceInlineEnv?: boolean
  serverNamePattern?: string
  /**
   * Client-specific directories where the Agent Plugin package should be
   * installed. Only used when installStrategy is "agent-plugin".
   */
  pluginLocations?: ConfigLocation[]
  source?: { url?: string | null; checkedOn?: string }
  gotchas: string[]
}

export interface InstallOptions {
  transport: Transport
  apiUrl: string
  secretMode: "inline" | "interpolated" | "shell" | "header"
  apiKey?: string
  serverName?: string
}

export interface RenderedConfig {
  content: string
  format: ConfigFormat
}

export interface RenderedEntry {
  rootKey: string
  entryKey: string
  value: unknown
}

export type InstallOutcome =
  "CONFIGURED" | "ALREADY_CONFIGURED" | "DELEGATED" | "MANUAL_REQUIRED" | "NOT_DETECTED" | "FAILED"
