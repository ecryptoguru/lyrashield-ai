/**
 * Scan-bound connector invocation — the thin bridge between the worker and
 * the delegated connector service in @lyrashield/db.
 *
 * All enforcement lives server-side in `invokeConnectorTool` (admission,
 * connection state/scope/expiry, idempotent claim, output cap, fail-closed
 * denial recording). This module only does what the service deliberately
 * delegates: resolve the bound connection's credential (sealed vault read for
 * Slack; installation id for GitHub App token minting) and hand the call to
 * the registered tool.
 *
 * A denied call is a recorded denial — callers should surface the denial code
 * as missing context, never as passed coverage (scan-bound calls already get
 * a BLOCKED/FAILED coverage receipt from the service).
 */
import {
  invokeConnectorTool,
  isConnectorProvider,
  type ConnectorCredentialShape,
  type ConnectorInvocationResult,
  type ConnectorProviderId,
} from "@lyrashield/db"
import type { Integration } from "@lyrashield/db"
import {
  capConnectorOutput,
  connectorToolResource,
  getConnectorTool,
} from "@lyrashield/integrations"
import { readEncryptedArtifact } from "@lyrashield/evidence-storage"

export interface ScanConnectorInvocationParams {
  workspaceId: string
  /** When set, the outcome is also recorded on the scan's coverage receipts. */
  scanId?: string
  toolName: string
  input: Record<string, unknown>
  /** Caller's idempotency key — replays return the recorded outcome. */
  idempotencyKey: string
  fetchFn?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * Resolve the provider credential for a bound connection. GitHub resolves to
 * the App installation id (the per-call installation token is minted by the
 * integrations module); Slack reads its sealed bot token from the encrypted
 * evidence vault by configRef. Credential bytes are returned to the tool only —
 * never logged, never persisted into the operation result.
 */
async function resolveConnectorCredential(
  workspaceId: string,
  provider: ConnectorProviderId,
  connection: Integration
): Promise<ConnectorCredentialShape | null> {
  if (provider === "github") {
    const metadata = isRecord(connection.metadata) ? connection.metadata : {}
    const installationId =
      typeof metadata.installationId === "number"
        ? metadata.installationId
        : typeof connection.externalId === "string" && /^\d+$/.test(connection.externalId)
          ? Number(connection.externalId)
          : null
    if (installationId === null) return null
    return { kind: "github_installation", installationId }
  }

  if (provider === "slack") {
    if (!connection.configRef) return null
    // configRef is a sealed artifact URI, never the token itself.
    const artifact = await readEncryptedArtifact(connection.configRef, workspaceId)
    const parsed: unknown = JSON.parse(artifact.content.toString("utf8"))
    if (!isRecord(parsed) || typeof parsed.botToken !== "string" || !parsed.botToken) {
      return null
    }
    return { kind: "slack_bot", botToken: parsed.botToken }
  }

  return null
}

/**
 * Invoke a registered connector tool under the delegated-authorization
 * contract. Unknown tools/providers deny before any connection lookup; the
 * service owns every subsequent check.
 */
export async function invokeScanConnectorTool(
  params: ScanConnectorInvocationParams
): Promise<ConnectorInvocationResult> {
  const tool = getConnectorTool(params.toolName)
  if (!tool || !isConnectorProvider(tool.provider)) {
    return {
      ok: false,
      code: "INPUT_INVALID",
      reason: `Unknown connector tool: ${params.toolName}`,
    }
  }

  return invokeConnectorTool({
    workspaceId: params.workspaceId,
    provider: tool.provider as ConnectorProviderId,
    tool: {
      name: tool.name,
      provider: tool.provider as ConnectorProviderId,
      requiredScope: tool.requiredScope,
      maxOutputBytes: tool.maxOutputBytes,
      validateInput: tool.validateInput,
    },
    input: params.input,
    idempotencyKey: params.idempotencyKey,
    scanId: params.scanId,
    resourceOf: (input) => connectorToolResource(tool, input),
    capOutput: capConnectorOutput,
    resolveCredential: (connection) =>
      resolveConnectorCredential(
        params.workspaceId,
        tool.provider as ConnectorProviderId,
        connection
      ),
    execute: ({ connection, credential, input }) =>
      tool.execute(
        {
          workspaceId: params.workspaceId,
          connectionId: connection.id,
          credential,
          fetchFn: params.fetchFn,
        },
        input as never
      ),
  })
}
