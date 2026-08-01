import type {
  AgentEntry,
  ConfigFormat,
  InstallOptions,
  RenderedConfig,
  RenderedEntry,
} from "./types"

export const API_URL_PLACEHOLDER = "<apiUrl>"

function assertConfigFileAgent(
  agent: AgentEntry
): asserts agent is AgentEntry & { format: ConfigFormat; rootKey: string } {
  if (agent.installStrategy !== "config-file") {
    throw new Error(
      `Agent "${agent.id}" uses installStrategy "${agent.installStrategy}"; renderConfig/renderEntry only support "config-file" agents.`
    )
  }
  if (!agent.format || !agent.rootKey) {
    throw new Error(`Agent "${agent.id}" is missing format or rootKey and cannot be rendered.`)
  }
}

function resolveSecret(
  agent: AgentEntry,
  opts: InstallOptions,
  forHeader: boolean
): string | undefined {
  if (agent.credential.kind === "shell-env") return undefined
  if (opts.secretMode === "shell") return undefined

  if (opts.secretMode === "interpolated") {
    if (agent.credential.kind === "interpolated-env") {
      return agent.credential.syntax
    }
    // Fallback for agents that do not support interpolation.
    return "<LYRASHIELD_API_KEY>"
  }

  if (opts.secretMode === "header") {
    if (forHeader) return opts.apiKey ?? "<LYRASHIELD_API_KEY>"
    // header mode on stdio is treated as inline.
    return opts.apiKey ?? "<LYRASHIELD_API_KEY>"
  }

  return opts.apiKey ?? "<LYRASHIELD_API_KEY>"
}

function buildEnvBlock(agent: AgentEntry, opts: InstallOptions): Record<string, string> {
  const env: Record<string, string> = {
    LYRASHIELD_API_URL: opts.apiUrl,
  }

  const secret = resolveSecret(agent, opts, false)
  if (secret !== undefined) {
    env.LYRASHIELD_API_KEY = secret
  }

  return env
}

function buildStdioEntry(agent: AgentEntry, opts: InstallOptions): Record<string, unknown> {
  const env = buildEnvBlock(agent, opts)

  // Agents whose local MCP config uses a command ARRAY + `environment` map (MiMo
  // Code) instead of the standard command string + args + env triple.
  if (agent.stdioStyle === "array-command-environment") {
    const entry: Record<string, unknown> = {
      command: ["npx", "-y", "@lyrashield/mcp"],
      environment: env,
      enabled: true,
    }
    if (agent.transportFields?.stdio) {
      Object.assign(entry, agent.transportFields.stdio)
    }
    return entry
  }

  let entry: Record<string, unknown>

  if (agent.commandWrapperKey) {
    entry = {
      [agent.commandWrapperKey]: {
        path: "npx",
        args: ["-y", "@lyrashield/mcp"],
        env,
      },
    }
  } else {
    entry = {
      command: "npx",
      args: ["-y", "@lyrashield/mcp"],
    }
    if (agent.credential.kind === "env-names") {
      entry[agent.credential.field] = env
    } else {
      entry.env = env
    }
  }

  if (agent.requiredEntryFields) {
    Object.assign(entry, agent.requiredEntryFields)
  }

  if (agent.transportFields?.stdio) {
    Object.assign(entry, agent.transportFields.stdio)
  }

  return entry
}

function deriveMcpUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/$/, "")
  if (base.endsWith("/api/mcp")) return base
  if (base.endsWith("/api/v1")) return base.replace(/\/api\/v1$/, "") + "/api/mcp"
  if (base.endsWith("/api")) return base.replace(/\/api$/, "") + "/api/mcp"
  return base + "/api/mcp"
}

function buildRemoteEntry(agent: AgentEntry, opts: InstallOptions): Record<string, unknown> {
  const secret = resolveSecret(agent, opts, true)
  const headers: Record<string, string> = {}
  if (secret !== undefined) {
    headers.Authorization = `Bearer ${secret}`
  }

  const mcpUrl = deriveMcpUrl(opts.apiUrl)
  const remoteFields = { ...agent.transportFields?.["remote-http"] }
  let urlKey = "url"
  for (const [key, value] of Object.entries(remoteFields)) {
    if (value === API_URL_PLACEHOLDER) {
      urlKey = key
      remoteFields[key] = mcpUrl
    }
  }

  const entry: Record<string, unknown> = {
    [urlKey]: mcpUrl,
    headers,
  }

  Object.assign(entry, remoteFields)

  if (agent.requiredEntryFields) {
    Object.assign(entry, agent.requiredEntryFields)
  }

  return entry
}

function buildServerEntry(agent: AgentEntry, opts: InstallOptions): Record<string, unknown> {
  if (opts.transport === "stdio") {
    return buildStdioEntry(agent, opts)
  }
  return buildRemoteEntry(agent, opts)
}

function escapeTomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return escapeTomlString(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    return `[${value.map(tomlValue).join(", ")}]`
  }
  return ""
}

function serializeToml(rootKey: string, entryKey: string, entry: Record<string, unknown>): string {
  const lines: string[] = []
  lines.push(`[${rootKey}.${entryKey}]`)

  const nested: Array<[string, Record<string, unknown>]> = []

  for (const [key, value] of Object.entries(entry)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      nested.push([key, value as Record<string, unknown>])
    } else {
      lines.push(`${key} = ${tomlValue(value)}`)
    }
  }

  for (const [section, obj] of nested) {
    lines.push("")
    lines.push(`[${rootKey}.${entryKey}.${section}]`)
    for (const [key, value] of Object.entries(obj)) {
      lines.push(`${key} = ${tomlValue(value)}`)
    }
  }

  return lines.join("\n")
}

function escapeYamlString(value: string): string {
  return JSON.stringify(value)
}

function yamlValue(value: unknown, indent: number): string {
  const pad = " ".repeat(indent)
  if (typeof value === "string") return escapeYamlString(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    const lines: string[] = []
    for (const item of value) {
      lines.push(`${pad}- ${yamlValue(item, indent + 2)}`)
    }
    return lines.join("\n")
  }
  if (value !== null && typeof value === "object") {
    const lines: string[] = []
    for (const [key, v] of Object.entries(value)) {
      const child = yamlValue(v, indent + 2)
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        lines.push(`${pad}${key}:`)
        lines.push(child)
      } else if (Array.isArray(v)) {
        lines.push(`${pad}${key}:`)
        lines.push(child)
      } else {
        lines.push(`${pad}${key}: ${child}`)
      }
    }
    return lines.join("\n")
  }
  return ""
}

function serializeYaml(rootKey: string, entryKey: string, entry: Record<string, unknown>): string {
  const root: Record<string, unknown> = {
    [rootKey]: {
      [entryKey]: entry,
    },
  }
  return yamlValue(root, 0)
}

function assertServerName(agent: AgentEntry, serverName: string): void {
  if (!agent.serverNamePattern) return
  // eslint-disable-next-line security/detect-non-literal-regexp
  if (!new RegExp(agent.serverNamePattern).test(serverName)) {
    throw new Error(
      `Agent "${agent.id}" requires serverName to match /${agent.serverNamePattern}/; got "${serverName}".`
    )
  }
}

function serializeContent(
  format: ConfigFormat,
  rootKey: string,
  entryKey: string,
  entry: Record<string, unknown>
): string {
  if (format === "jsonc") {
    throw new Error(
      "renderConfig cannot preserve JSONC comments; use renderEntry + mergeJsonc instead."
    )
  }

  if (format === "json") {
    return JSON.stringify({ [rootKey]: { [entryKey]: entry } }, null, 2)
  }

  if (format === "toml") {
    return serializeToml(rootKey, entryKey, entry)
  }

  return serializeYaml(rootKey, entryKey, entry)
}

export function renderConfig(agent: AgentEntry, opts: InstallOptions): RenderedConfig {
  assertConfigFileAgent(agent)

  const serverName = opts.serverName ?? "lyrashield"
  assertServerName(agent, serverName)
  const entry = buildServerEntry(agent, opts)

  return {
    content: serializeContent(agent.format, agent.rootKey, serverName, entry),
    format: agent.format,
  }
}

export function renderEntry(agent: AgentEntry, opts: InstallOptions): RenderedEntry {
  assertConfigFileAgent(agent)

  const serverName = opts.serverName ?? "lyrashield"
  assertServerName(agent, serverName)
  const value = buildServerEntry(agent, opts)

  return {
    rootKey: agent.rootKey,
    entryKey: serverName,
    value,
  }
}
