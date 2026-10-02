export type ConfigFormat = "json" | "jsonc" | "toml" | "yaml"
export type InstallStrategy = "config-file" | "vendor-cli" | "guided-manual" | "agent-plugin"
export type Transport = "stdio" | "remote-http"
export type SupportTier = "NATIVE" | "VERIFIED" | "COMPATIBLE" | "EXPERIMENTAL" | "DEPRECATED"
export type VerificationEvidence = "DOCUMENTATION" | "PACKAGE_CONFORMANCE" | "CLIENT_RUNTIME"
export type VerificationPlatform = "darwin" | "linux" | "win32"
export type ClientSurface = "cli" | "ide" | "desktop" | "web" | "cloud"
export type NativeCapability = "plugin" | "skills" | "commands" | "rules" | "hooks"
export type DistributionState =
  "DIRECT" | "PREPARATION" | "SUBMITTED" | "APPROVED" | "PUBLISHED" | "REJECTED" | "UNKNOWN"

export interface IntegrationVerification {
  evidence: VerificationEvidence
  checkedOn: string
  clientVersion: string | null
  platforms: VerificationPlatform[]
  /** Stable test, artifact, or external source that supports the current tier. */
  reference: string
  /** Retained runtime receipt. Required before claiming NATIVE or VERIFIED. */
  receipt: string | null
}

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
  aliases?: string[]
  displayName: string
  /** Shared product heading for separately configured client surfaces. */
  productFamily?: { id: string; name: string }
  surface?: ClientSurface
  versionConstraints?: { minimum?: string; maximum?: string; note?: string }
  /** Documented component types the client surface can discover; not a claim that LyraShield ships each type. */
  nativeCapabilities?: NativeCapability[]
  skillLocations?: ConfigLocation[]
  /** Withheld when the shipped skill set is not yet safe and validated for this client surface. */
  skillInstallState?: "withheld"
  distribution?: { channel: string; url: string; state: DistributionState }
  docsSlug: string
  installStrategy: InstallStrategy
  format: ConfigFormat | null
  rootKey: string | null
  locations: ConfigLocation[]
  transports: Transport[]
  integrationKind?: "mcp" | "standalone-cli"
  preferredTransport?: Transport | null
  /** Preferred authentication for native remote HTTP connections. */
  remoteAuth?: "oauth" | "api-key"
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
  serverNamePattern?: string
  /**
   * Client-specific directories where the Agent Plugin package should be
   * installed. Only used when installStrategy is "agent-plugin".
   */
  pluginLocations?: ConfigLocation[]
  /** Exact guidance for clients without a native config or installer contract. */
  manualInstructions?: string
  source?: { url?: string | null; checkedOn?: string }
  /** Registry exports always populate these fields; optional keeps fixture authors lightweight. */
  supportTier?: SupportTier
  verification?: IntegrationVerification
  gotchas: string[]
}

/** Entry returned by the registry after support evidence is attached. */
export type RegistryAgentEntry = AgentEntry & {
  integrationKind: "mcp" | "standalone-cli"
  preferredTransport: Transport | null
  supportTier: SupportTier
  verification: IntegrationVerification
}

export interface InstallOptions {
  /** Preserve stored OAuth refresh and custom origin instead of injecting environment overrides. */
  useCredentialStore?: boolean
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
