/**
 * Outbound connector service — execution-time authorization and idempotent
 * invocation for read-only provider connectors (GitHub, Slack).
 *
 * The model mirrors remote-MCP delegation: the connection row (an
 * `Integration` bound to a workspace OAuth/installation grant) is resolved at
 * execution time, never trusted from a caller's claim; membership is enforced
 * by the workspace RLS boundary plus the route layer's `requirePermission`;
 * connection status/scope/expiry are re-checked per call; and invocations
 * claim `AgentOperation` rows so replays return the recorded outcome instead
 * of re-executing.
 *
 * Denials fail closed and are recorded: a denied invocation leaves a FAILED
 * operation row carrying the denial code (and, for scan-bound calls, a
 * coverage receipt marking the context as missing — a failed connector is
 * never presented as passed coverage).
 *
 * Reconnects preserve the Integration row (same id), which keeps the
 * `connector:<id>` operation principal — and its idempotency history — intact.
 */
import type { Integration, Prisma } from "./generated/prisma"
import { env } from "@lyrashield/config"
import { evaluateConnectorAdmission } from "@lyrashield/security"
import { logger } from "@lyrashield/logger"
import {
  claimOrGetAgentOperation,
  completeAgentOperation,
  failAgentOperation,
} from "./agent-operation-service"
import { withWorkspaceRLS } from "./rls"

// ── Providers ───────────────────────────────────────────────────────────────

export const CONNECTOR_PROVIDERS = ["github", "slack"] as const
export type ConnectorProviderId = (typeof CONNECTOR_PROVIDERS)[number]

const PROVIDER_TO_INTEGRATION_TYPE = {
  github: "GITHUB",
  slack: "SLACK",
} as const satisfies Record<ConnectorProviderId, string>

export function isConnectorProvider(value: string): value is ConnectorProviderId {
  return (CONNECTOR_PROVIDERS as readonly string[]).includes(value)
}

/** Default admission policy — the shared canary evaluator from @lyrashield/security. */
export function defaultConnectorAdmission(workspaceId: string): boolean {
  return evaluateConnectorAdmission({
    mode: env.OUTBOUND_CONNECTOR_ADMISSION,
    workspaceId,
    canaryWorkspaceIds: env.CONNECTOR_CANARY_WORKSPACE_IDS,
  }).allowed
}

/** Operation principal bound to a connection row — stable across reconnects. */
export function connectorPrincipal(provider: ConnectorProviderId, integrationId?: string): string {
  return integrationId ? `connector:${provider}:${integrationId}` : `connector:${provider}:unbound`
}

// ── Denial contract ─────────────────────────────────────────────────────────

export type ConnectorDenialCode =
  | "CONNECTOR_NOT_ALLOWLISTED"
  | "CONNECTION_NOT_FOUND"
  | "WORKSPACE_MISMATCH"
  | "CONNECTION_DISABLED"
  | "CONNECTION_EXPIRED"
  | "TOOL_NOT_GRANTED"
  | "RESOURCE_OUT_OF_SCOPE"
  | "PLAN_NOT_ELIGIBLE"
  | "CREDENTIAL_UNAVAILABLE"
  | "INPUT_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "OPERATION_IN_PROGRESS"
  | "UPSTREAM_FAILED"

export interface ConnectorDenial {
  ok: false
  code: ConnectorDenialCode
  reason: string
  /** Operation id when the denial was recorded as an AgentOperation row. */
  operationId?: string
}

export interface ConnectorInvocationSuccess {
  ok: true
  operationId: string
  output: unknown
  truncated: boolean
  /** True when the stored result of a prior identical call was returned. */
  replayed: boolean
}

export type ConnectorInvocationResult = ConnectorInvocationSuccess | ConnectorDenial

/**
 * The tool contract the service executes against — a structural subset of the
 * provider `ConnectorTool` in @lyrashield/integrations, injected so this
 * package keeps its dependency direction (integrations → nothing; db →
 * internal services only).
 */
export interface ConnectorToolSpec {
  name: string
  provider: ConnectorProviderId
  /** Capability scope the connection must grant, e.g. "repo:metadata". */
  requiredScope: string
  maxOutputBytes: number
  validateInput(input: unknown): { ok: true; value: unknown } | { ok: false; reason: string }
}

export type ConnectorCredentialShape =
  { kind: "github_installation"; installationId: number } | { kind: "slack_bot"; botToken: string }

export interface ConnectorInvocationParams {
  workspaceId: string
  provider: ConnectorProviderId
  tool: ConnectorToolSpec
  /** Untrusted caller input — validated before any scope/resource check. */
  input: Record<string, unknown>
  idempotencyKey: string
  /** When set, an invocation outcome is also recorded as a coverage receipt. */
  scanId?: string
  /**
   * Derive the provider resource for scope checks, e.g. `repo:owner/name` or
   * `channel:C123`. Injected from the registry so this package stays free of
   * provider knowledge.
   */
  resourceOf?: (input: Record<string, unknown>) => string | undefined
  /** Resolve the connection's credential (vault read / token mint). */
  resolveCredential: (connection: Integration) => Promise<ConnectorCredentialShape | null>
  /** Execute the provider call; receives the resolved credential + validated input. */
  execute: (args: {
    connection: Integration
    credential: ConnectorCredentialShape
    input: unknown
  }) => Promise<unknown>
  /**
   * The sponsor account's trusted `effectivePlan`, resolved server-side from
   * the billing account (e.g. `resolveAccountBilling`) — NEVER
   * `workspace.plan`, which is a denormalized cache and is not the billing
   * authority. Evaluated by the PROVISIONAL plan gate in
   * `invokeConnectorTool`; absent or unknown plans fail closed.
   */
  sponsorEffectivePlan?: string
  /**
   * Admission override for tests. Default evaluates the configured
   * outbound-connector admission policy (off / canary allowlist / public).
   */
  isAdmitted?: (workspaceId: string) => boolean
  now?: () => number
  /** Serialized-output cap hook; defaults to a JSON.stringify byte cap. */
  capOutput?: (
    output: unknown,
    maxBytes: number
  ) => {
    output: unknown
    truncated: boolean
    bytes: number
  }
}

// ── Connection resolution ───────────────────────────────────────────────────

export async function resolveConnectorConnection(
  workspaceId: string,
  provider: ConnectorProviderId
): Promise<Integration | null> {
  return withWorkspaceRLS(workspaceId, (tx) =>
    tx.integration.findFirst({
      where: {
        workspaceId,
        type: PROVIDER_TO_INTEGRATION_TYPE[provider] as Integration["type"],
        deletedAt: null,
      },
    })
  )
}

/** Safe list projection — never exposes configRef or credential material. */
export async function listConnectorConnections(workspaceId: string): Promise<
  Array<{
    id: string
    type: string
    name: string
    status: string
    externalId: string | null
    capabilities: unknown
    createdAt: Date
    updatedAt: Date
  }>
> {
  return withWorkspaceRLS(workspaceId, (tx) =>
    tx.integration.findMany({
      where: { workspaceId, deletedAt: null },
      select: {
        id: true,
        type: true,
        name: true,
        status: true,
        externalId: true,
        capabilities: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    })
  )
}

// ── Capability parsing ──────────────────────────────────────────────────────

interface ConnectorCapabilities {
  /** Registered tool names this connection may invoke; absent = all registered. */
  tools?: string[]
  /** OAuth-style scopes granted to the connection; absent = unconstrained. */
  scopes?: string[]
  /** Provider resources in scope, e.g. "repo:org/name" or "channel:C123". */
  resources?: string[]
}

function readStringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const list = value.filter((v): v is string => typeof v === "string" && v.length <= 512)
  return list
}

function parseCapabilities(raw: unknown): ConnectorCapabilities {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  return {
    tools: readStringList(record.tools),
    scopes: readStringList(record.scopes),
    resources: readStringList(record.resources),
  }
}

function metadataExpiresAt(raw: unknown): number | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const value = (raw as Record<string, unknown>).expiresAt
  if (typeof value !== "string" || !value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

// ── Pure authorization check (unit-testable, no DB) ─────────────────────────

export type ConnectorAuthzResult =
  { authorized: true } | { authorized: false; code: ConnectorDenialCode; reason: string }

export function checkConnectorAuthorization(params: {
  connection: Pick<
    Integration,
    "id" | "workspaceId" | "type" | "status" | "capabilities" | "metadata"
  > | null
  workspaceId: string
  tool: Pick<ConnectorToolSpec, "name" | "provider" | "requiredScope">
  /** Provider resource from connectorToolResource (already-validated input). */
  resource?: string
  now?: number
}): ConnectorAuthzResult {
  const { connection, workspaceId, tool, resource } = params
  const now = params.now ?? Date.now()

  if (!connection) {
    return {
      authorized: false,
      code: "CONNECTION_NOT_FOUND",
      reason: `No ${tool.provider} connection exists for this workspace`,
    }
  }
  if (connection.workspaceId !== workspaceId) {
    return {
      authorized: false,
      code: "WORKSPACE_MISMATCH",
      reason: "Connection belongs to a different workspace",
    }
  }
  if (connection.status !== "active") {
    const reason =
      connection.metadata &&
      typeof connection.metadata === "object" &&
      !Array.isArray(connection.metadata) &&
      typeof (connection.metadata as Record<string, unknown>).disabledReason === "string"
        ? ((connection.metadata as Record<string, unknown>).disabledReason as string)
        : `Connection status is ${connection.status}`
    return { authorized: false, code: "CONNECTION_DISABLED", reason }
  }
  const expiresAt = metadataExpiresAt(connection.metadata)
  if (expiresAt !== null && expiresAt <= now) {
    return {
      authorized: false,
      code: "CONNECTION_EXPIRED",
      reason: "Connection grant has expired; reconnect the integration",
    }
  }

  const capabilities = parseCapabilities(connection.capabilities)

  if (capabilities.tools && !capabilities.tools.includes(tool.name)) {
    return {
      authorized: false,
      code: "TOOL_NOT_GRANTED",
      reason: `Tool ${tool.name} is not granted on this connection`,
    }
  }
  // Fail closed on the scope grant itself: a connection whose recorded
  // capabilities are missing, non-object or carry no valid `scopes` list can
  // never prove it holds the tool's required scope. `tools` and `resources`
  // stay optional (absent = unconstrained) by contract; `scopes` is not.
  if (!capabilities.scopes) {
    return {
      authorized: false,
      code: "TOOL_NOT_GRANTED",
      reason: `Connection records no granted-scope list; cannot verify ${tool.requiredScope} for ${tool.name}`,
    }
  }
  if (!capabilities.scopes.includes(tool.requiredScope)) {
    return {
      authorized: false,
      code: "TOOL_NOT_GRANTED",
      reason: `Connection lacks required scope ${tool.requiredScope} for ${tool.name}`,
    }
  }
  if (resource && capabilities.resources && !capabilities.resources.includes(resource)) {
    return {
      authorized: false,
      code: "RESOURCE_OUT_OF_SCOPE",
      reason: `Resource ${resource} is outside this connection's granted scope`,
    }
  }

  return { authorized: true }
}

// ── Coverage receipt for scan-bound calls ───────────────────────────────────

const CONNECTOR_RECEIPT_PREFIX = "connector:"

/** Authorization-style denials are BLOCKED context; runtime failures are FAILED. */
const RECEIPT_STATUS_BY_CODE: Partial<Record<ConnectorDenialCode, "BLOCKED" | "FAILED">> = {
  CONNECTOR_NOT_ALLOWLISTED: "BLOCKED",
  CONNECTION_NOT_FOUND: "BLOCKED",
  WORKSPACE_MISMATCH: "BLOCKED",
  CONNECTION_DISABLED: "BLOCKED",
  CONNECTION_EXPIRED: "BLOCKED",
  TOOL_NOT_GRANTED: "BLOCKED",
  RESOURCE_OUT_OF_SCOPE: "BLOCKED",
  PLAN_NOT_ELIGIBLE: "BLOCKED",
  CREDENTIAL_UNAVAILABLE: "FAILED",
  INPUT_INVALID: "FAILED",
  UPSTREAM_FAILED: "FAILED",
}

async function recordConnectorReceipt(
  scanId: string,
  workspaceId: string,
  params: {
    toolName: string
    outcome: "COMPLETED" | "BLOCKED" | "FAILED"
    reason?: string
  }
): Promise<void> {
  const controlId = `${CONNECTOR_RECEIPT_PREFIX}${params.toolName}`.slice(0, 255)
  try {
    await withWorkspaceRLS(workspaceId, (tx) =>
      tx.scanCoverageReceipt.upsert({
        where: { scanId_controlId: { scanId, controlId } },
        create: {
          scanId,
          scanner: "connector",
          controlId,
          status: params.outcome,
          reason: params.reason ?? null,
          metadata: { declaredBy: "connector_runtime", tool: params.toolName },
        },
        update: {
          status: params.outcome,
          reason: params.reason ?? null,
        },
      })
    )
  } catch (err) {
    // A receipt write failure must not fail the invocation itself — the
    // operation row already carries the outcome.
    logger.warn("Failed to record connector coverage receipt", {
      scanId,
      toolName: params.toolName,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ── Idempotent invocation ───────────────────────────────────────────────────

/**
 * Connector plan gate. Connector tools are limited to the Agency tier and
 * Enterprise sponsors: LAUNCH_ASSURANCE is the self-serve Agency plan billing
 * resolves (`effectivePlan === "LAUNCH_ASSURANCE"`), AGENCY covers legacy
 * sponsor rows, and ENTERPRISE is contact-led. This is a policy constant, not
 * pricing: do not edit it as part of plan or billing changes.
 */
export const CONNECTOR_ALLOWED_PLANS: readonly string[] = [
  "AGENCY",
  "LAUNCH_ASSURANCE",
  "ENTERPRISE",
]

function defaultCapOutput(
  output: unknown,
  maxBytes: number
): { output: unknown; truncated: boolean; bytes: number } {
  let serialized: string
  try {
    serialized = JSON.stringify(output) ?? "null"
  } catch {
    throw new Error("CONNECTOR_OUTPUT_UNSERIALIZABLE")
  }
  const bytes = Buffer.byteLength(serialized, "utf8")
  if (bytes <= maxBytes) return { output, truncated: false, bytes }
  const previewBytes = Math.max(0, Math.min(maxBytes - 128, 16 * 1024))
  const preview = Buffer.from(serialized, "utf8").subarray(0, previewBytes).toString("utf8")
  const capped = { _truncated: true, originalBytes: bytes, preview }
  return { output: capped, truncated: true, bytes: Buffer.byteLength(JSON.stringify(capped)) }
}

async function denyInvocation(
  workspaceId: string,
  operationId: string | undefined,
  code: ConnectorDenialCode,
  reason: string,
  scanId?: string,
  toolName?: string
): Promise<ConnectorDenial> {
  if (operationId) {
    try {
      await failAgentOperation(operationId, workspaceId, { error: code })
    } catch (err) {
      logger.warn("Failed to record connector denial", {
        operationId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (scanId && toolName) {
    await recordConnectorReceipt(scanId, workspaceId, {
      toolName,
      outcome: RECEIPT_STATUS_BY_CODE[code] ?? "FAILED",
      reason: code,
    })
  }
  return { ok: false, code, reason, ...(operationId ? { operationId } : {}) }
}

export async function invokeConnectorTool(
  params: ConnectorInvocationParams
): Promise<ConnectorInvocationResult> {
  const { workspaceId, provider, tool, input, idempotencyKey, scanId } = params

  if (tool.provider !== provider) {
    return { ok: false, code: "INPUT_INVALID", reason: "Tool/provider mismatch" }
  }

  // Admission: connectors are opt-in, never default-on. The default policy
  // mirrors billing admission (off → deny all; canary → explicit allowlist;
  // malformed allowlist → fail closed).
  const admitted = params.isAdmitted
    ? params.isAdmitted(workspaceId)
    : defaultConnectorAdmission(workspaceId)
  if (!admitted) {
    return {
      ok: false,
      code: "CONNECTOR_NOT_ALLOWLISTED",
      reason: "Outbound connectors are not enabled for this workspace",
    }
  }

  // Plan gate: connector tool invocation is limited to the Agency tier and
  // Enterprise sponsors. The caller supplies the sponsor account's trusted
  // `effectivePlan`; an absent or unrecognized plan fails closed before any
  // connection lookup or idempotent claim.
  if (!CONNECTOR_ALLOWED_PLANS.includes(params.sponsorEffectivePlan ?? "")) {
    return {
      ok: false,
      code: "PLAN_NOT_ELIGIBLE",
      reason: "Connector tools require an Agency or Enterprise sponsor plan",
    }
  }

  const connection = await resolveConnectorConnection(workspaceId, provider)
  const principal = connectorPrincipal(provider, connection?.id)

  // Claim first so replays and denials share one idempotent record — the same
  // machinery remote-MCP delegation uses.
  const claim = await claimOrGetAgentOperation({
    workspaceId,
    operationName: tool.name,
    idempotencyKey,
    input,
    connectorPrincipal: principal,
  })

  if (claim.status === "CONFLICT") {
    return {
      ok: false,
      code: "IDEMPOTENCY_CONFLICT",
      reason: "Idempotency key was already used with different input",
    }
  }
  if (claim.status === "FAILED") {
    return {
      ok: false,
      code: "UPSTREAM_FAILED",
      reason:
        "This invocation previously failed and will not be retried under the same idempotency key",
      operationId: claim.operation.id,
    }
  }
  if (claim.status === "IN_PROGRESS") {
    return {
      ok: false,
      code: "OPERATION_IN_PROGRESS",
      reason: "This invocation is already in progress under the same idempotency key",
      operationId: claim.operation.id,
    }
  }

  // Connection-level authorization first — a missing/disabled/expired
  // connection denies before caller input is even inspected.
  const connectionAuthz = checkConnectorAuthorization({
    connection,
    workspaceId,
    tool,
    now: params.now?.(),
  })

  // Input is validated before resource derivation — scope extraction must
  // never run on unvalidated caller data.
  let validatedInput: unknown = input
  let resourceAuthz: ConnectorAuthzResult = { authorized: true }
  if (connectionAuthz.authorized) {
    const validated = tool.validateInput(input)
    if (!validated.ok) {
      resourceAuthz = { authorized: false, code: "INPUT_INVALID", reason: validated.reason }
    } else {
      validatedInput = validated.value
      const resource = params.resourceOf?.(validated.value as Record<string, unknown>)
      resourceAuthz = checkConnectorAuthorization({
        connection,
        workspaceId,
        tool,
        resource,
        now: params.now?.(),
      })
    }
  } else {
    resourceAuthz = connectionAuthz
  }
  const authz = connectionAuthz.authorized ? resourceAuthz : connectionAuthz

  if (claim.status === "REPLAY") {
    // Same contract as remote-MCP replay: the stored result is only returned
    // while the connection still passes authorization — a revoked or disabled
    // connection fails closed instead of replaying its cached output. The
    // denial is still recorded as scan-missing-context when bound to a scan.
    if (!authz.authorized) {
      if (scanId) {
        await recordConnectorReceipt(scanId, workspaceId, {
          toolName: tool.name,
          outcome: RECEIPT_STATUS_BY_CODE[authz.code] ?? "FAILED",
          reason: authz.code,
        })
      }
      return { ok: false, code: authz.code, reason: authz.reason }
    }
    if (!claim.operation.result || typeof claim.operation.result !== "object") {
      return {
        ok: false,
        code: "UPSTREAM_FAILED",
        reason: "The completed invocation result is unavailable; the call will not be rerun",
      }
    }
    const stored = claim.operation.result as {
      output?: unknown
      truncated?: boolean
    }
    return {
      ok: true,
      operationId: claim.operation.id,
      output: stored.output,
      truncated: stored.truncated === true,
      replayed: true,
    }
  }

  // NEW claim — authorize, then execute.
  if (!authz.authorized) {
    return denyInvocation(
      workspaceId,
      claim.operation.id,
      authz.code,
      authz.reason,
      scanId,
      tool.name
    )
  }

  let credential: ConnectorCredentialShape | null
  try {
    credential = await params.resolveCredential(connection!)
  } catch (err) {
    logger.warn("Connector credential resolution failed", {
      workspaceId,
      provider,
      connectionId: connection!.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return denyInvocation(
      workspaceId,
      claim.operation.id,
      "CREDENTIAL_UNAVAILABLE",
      "Connection credentials could not be resolved",
      scanId,
      tool.name
    )
  }
  if (!credential) {
    return denyInvocation(
      workspaceId,
      claim.operation.id,
      "CREDENTIAL_UNAVAILABLE",
      "Connection has no resolvable credential",
      scanId,
      tool.name
    )
  }

  let rawOutput: unknown
  try {
    rawOutput = await params.execute({
      connection: connection!,
      credential,
      input: validatedInput,
    })
  } catch (err) {
    logger.warn("Connector tool execution failed", {
      workspaceId,
      provider,
      tool: tool.name,
      connectionId: connection!.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return denyInvocation(
      workspaceId,
      claim.operation.id,
      "UPSTREAM_FAILED",
      "Provider call failed",
      scanId,
      tool.name
    )
  }

  const cap = params.capOutput ?? defaultCapOutput
  let capped: { output: unknown; truncated: boolean; bytes: number }
  try {
    capped = cap(rawOutput, tool.maxOutputBytes)
  } catch {
    return denyInvocation(
      workspaceId,
      claim.operation.id,
      "UPSTREAM_FAILED",
      "Provider output could not be bounded",
      scanId,
      tool.name
    )
  }

  await completeAgentOperation(claim.operation.id, workspaceId, {
    result: {
      output: capped.output as Prisma.InputJsonValue,
      truncated: capped.truncated,
      bytes: capped.bytes,
    },
  })
  if (scanId) {
    await recordConnectorReceipt(scanId, workspaceId, {
      toolName: tool.name,
      outcome: "COMPLETED",
    })
  }

  return {
    ok: true,
    operationId: claim.operation.id,
    output: capped.output,
    truncated: capped.truncated,
    replayed: false,
  }
}

// ── Connection lifecycle ────────────────────────────────────────────────────

export class ConnectorConnectionError extends Error {
  constructor(
    message: string,
    readonly code: "ALREADY_CLAIMED" | "NOT_FOUND" | "INVALID"
  ) {
    super(message)
    this.name = "ConnectorConnectionError"
  }
}

export interface UpsertConnectorConnectionParams {
  workspaceId: string
  provider: ConnectorProviderId
  /** Provider-side identity (GitHub installation id, Slack team id). */
  externalId: string
  name: string
  /** Sealed-credential reference (encrypted artifact URI); never a secret. */
  configRef?: string | null
  capabilities?: ConnectorCapabilities
  metadata?: Record<string, unknown>
}

/**
 * Create or revive a workspace's provider connection.
 *
 * A reconnect updates the existing Integration row in place — so the row id,
 * and therefore every `connector:<id>` operation's idempotency identity, is
 * preserved. The lookup is workspace-scoped (the workspace extension also
 * injects `deletedAt: null` on reads), and a `(type, externalId)` unique
 * conflict on create — another workspace's row, or a soft-deleted row hidden
 * by the guard — fails closed as ALREADY_CLAIMED rather than rebinding.
 */
export async function upsertConnectorConnection(
  params: UpsertConnectorConnectionParams
): Promise<Integration> {
  const type = PROVIDER_TO_INTEGRATION_TYPE[params.provider] as Integration["type"]

  return withWorkspaceRLS(params.workspaceId, async (tx) => {
    const existing = await tx.integration.findFirst({
      where: { workspaceId: params.workspaceId, type, externalId: params.externalId },
    })

    if (existing) {
      // Reconnect in place — the row id (idempotency identity) survives.
      return tx.integration.update({
        where: { id: existing.id },
        data: {
          name: params.name,
          status: "active",
          deletedAt: null,
          ...(params.configRef !== undefined ? { configRef: params.configRef } : {}),
          capabilities: (params.capabilities ?? undefined) as Prisma.InputJsonValue | undefined,
          metadata: (params.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      })
    }

    try {
      return await tx.integration.create({
        data: {
          workspaceId: params.workspaceId,
          type,
          externalId: params.externalId,
          name: params.name,
          status: "active",
          configRef: params.configRef ?? null,
          capabilities: (params.capabilities ?? undefined) as Prisma.InputJsonValue | undefined,
          metadata: (params.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      })
    } catch (err) {
      // P2002: the provider identity is already claimed — either another
      // workspace's live row (invisible under the workspace guard) or this
      // workspace's soft-deleted row. Fail closed rather than rebind or hide.
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "P2002") {
        throw new ConnectorConnectionError(
          "This provider connection is already claimed by another workspace",
          "ALREADY_CLAIMED"
        )
      }
      throw err
    }
  })
}

/**
 * Disable (or re-enable) a connection without deleting the row. Disabled
 * connections fail closed at invocation time — status is re-checked per call
 * — while the recorded reason lands in metadata for audit and UI display.
 */
export async function setConnectorConnectionStatus(params: {
  workspaceId: string
  integrationId: string
  status: "active" | "disabled"
  reason?: string
}): Promise<Integration | null> {
  const { workspaceId, integrationId, status, reason } = params
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const existing = await tx.integration.findFirst({
      where: { id: integrationId, workspaceId, deletedAt: null },
    })
    if (!existing) return null
    const priorMetadata =
      existing.metadata &&
      typeof existing.metadata === "object" &&
      !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {}
    const metadata =
      status === "disabled"
        ? {
            ...priorMetadata,
            disabledReason: reason ?? "disabled",
            disabledAt: new Date().toISOString(),
          }
        : (() => {
            const next = { ...priorMetadata }
            delete next.disabledReason
            delete next.disabledAt
            return next
          })()
    return tx.integration.update({
      where: { id: existing.id },
      data: { status, metadata: metadata as Prisma.InputJsonValue },
    })
  })
}
