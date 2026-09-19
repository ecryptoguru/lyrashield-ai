/**
 * Outbound connector tool contracts.
 *
 * Connectors are read-only, opt-in outbound context providers for scans and
 * delegated workflows. Every tool is bound to a workspace's provider
 * connection (an `Integration` row whose OAuth/installation grant is resolved
 * at execution time) and runs under the same execution-time checks as the
 * remote-MCP delegation model: connection state, scope, expiry and
 * idempotency are re-verified on every invocation — a tool name that merely
 * claims read-only is never sufficient authorization.
 *
 * Provider credentials are resolved per invocation by the caller (installation
 * token mint, sealed config artifact, …) and passed in as `credential`; tool
 * inputs, relay grants, logs and operation results never carry them.
 */

export const CONNECTOR_PROVIDERS = ["github", "slack"] as const
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number]

export type ConnectorCredential =
  { kind: "github_installation"; installationId: number } | { kind: "slack_bot"; botToken: string }

export interface ConnectorInvocationContext {
  workspaceId: string
  /** Owning Integration row id — binds audit and idempotency identity. */
  connectionId: string
  credential: ConnectorCredential
  fetchFn?: typeof fetch
  signal?: AbortSignal
}

/** Bounded tool output — the only shape a connector may hand to a caller. */
export interface ConnectorToolResult {
  output: unknown
  /** True when the serialized payload exceeded the tool's byte cap. */
  truncated: boolean
  /** Serialized byte length of the (possibly truncated) output. */
  bytes: number
}

/**
 * A registered read-only connector tool. `execute` must perform only the
 * provider calls its declared HTTP-method/scope contract describes; the
 * relay grant and capability checks independently enforce read-only egress.
 */
export interface ConnectorTool<I = unknown> {
  /** Canonical tool name, e.g. "github.get_repository". */
  name: string
  provider: ConnectorProvider
  description: string
  /** Capability scope the connection must grant, e.g. "repo:read". */
  requiredScope: string
  readOnly: true
  /** Hard cap on serialized output bytes before model ingestion. */
  maxOutputBytes: number
  /** Validate untrusted caller input; never throws. */
  validateInput(input: unknown): { ok: true; value: I } | { ok: false; reason: string }
  execute(ctx: ConnectorInvocationContext, input: I): Promise<unknown>
}

export class ConnectorOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConnectorOutputError"
  }
}

/**
 * Serialize and hard-cap a tool payload for model ingestion. Payloads that
 * serialize past `maxBytes` are replaced by a self-describing truncation
 * marker plus a bounded preview — callers can tell a capped result from a
 * complete one, and an oversized/malicious provider response can never reach
 * the model unbounded.
 */
export function capConnectorOutput(output: unknown, maxBytes: number): ConnectorToolResult {
  let serialized: string
  try {
    serialized = JSON.stringify(output) ?? "null"
  } catch {
    throw new ConnectorOutputError("Connector output is not serializable")
  }
  const bytes = Buffer.byteLength(serialized, "utf8")
  if (bytes <= maxBytes) {
    return { output, truncated: false, bytes }
  }
  const previewBytes = Math.max(0, Math.min(maxBytes - 128, 16 * 1024))
  const preview = Buffer.from(serialized, "utf8").subarray(0, previewBytes).toString("utf8")
  return {
    output: {
      _truncated: true,
      originalBytes: bytes,
      preview,
    },
    truncated: true,
    bytes: Buffer.byteLength(JSON.stringify({ _truncated: true, originalBytes: bytes, preview })),
  }
}

// ── Shared untrusted-input helpers (kept dependency-free on purpose) ────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function stringField(
  input: Record<string, unknown>,
  field: string,
  { min = 1, max = 512, pattern }: { min?: number; max?: number; pattern?: RegExp } = {}
): { ok: true; value: string } | { ok: false; reason: string } {
  const value = input[field]
  if (typeof value !== "string" || value.length < min || value.length > max) {
    return { ok: false, reason: `${field} must be a string of ${min}–${max} characters` }
  }
  if (pattern && !pattern.test(value)) {
    return { ok: false, reason: `${field} has an invalid format` }
  }
  return { ok: true, value }
}

export function optionalEnumField<T extends string>(
  input: Record<string, unknown>,
  field: string,
  allowed: readonly T[]
): { ok: true; value: T | undefined } | { ok: false; reason: string } {
  const value = input[field]
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return { ok: false, reason: `${field} must be one of: ${allowed.join(", ")}` }
  }
  return { ok: true, value: value as T }
}
