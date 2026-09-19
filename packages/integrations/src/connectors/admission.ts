/**
 * Connector admission gate — env-reading wrapper over the pure evaluator in
 * @lyrashield/security. Outbound connectors are never default-on: `off`
 * denies every invocation, `canary` admits only the explicit workspace
 * allowlist, and a malformed allowlist fails closed.
 */
import { env } from "@lyrashield/config"
import { evaluateConnectorAdmission, type ConnectorAdmissionDecision } from "@lyrashield/security"

export function getConnectorAdmission(workspaceId: string): ConnectorAdmissionDecision {
  return evaluateConnectorAdmission({
    mode: env.OUTBOUND_CONNECTOR_ADMISSION,
    workspaceId,
    canaryWorkspaceIds: env.CONNECTOR_CANARY_WORKSPACE_IDS,
  })
}

export {
  evaluateConnectorAdmission,
  parseConnectorCanaryWorkspaceIds,
  type ConnectorAdmissionDecision,
  type ConnectorAdmissionMode,
  type ConnectorAdmissionReason,
} from "@lyrashield/security"
