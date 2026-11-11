import { uploadEncryptedArtifact } from "@lyrashield/evidence-storage"
import { logger } from "@lyrashield/logger"
import { randomUUID } from "node:crypto"
import { addScanEvent, type AuthenticatedAssessmentAuthorization } from "@lyrashield/db"
import type { RelaySessionBinding } from "@lyrashield/security"
import {
  registerRelayGrant,
  fetchRelayAudit,
  revokeRelayGrant,
  type mintScanRelayGrant,
  type RelayRuntimeConfig,
} from "../../engine/relay-client"
import { revokeFailedRelayRegistration } from "./cleanup"
import type { ScanJobResult } from "../../types"

export async function relaySetupFailure(
  scanId: string,
  targetType: string,
  grantError: unknown,
  afterClaim = false
): Promise<{ ok: false; result: ScanJobResult }> {
  try {
    await addScanEvent(scanId, "engine_skipped", "error", "Relay scope could not be established", {
      targetType,
      error: grantError instanceof Error ? grantError.message : String(grantError),
    })
  } catch (eventError) {
    // A reporting outage cannot turn a proven pre-dispatch denial into uncertain spend.
    if (!afterClaim) throw eventError
  }
  return {
    ok: false,
    result: {
      status: "failed",
      errorCategory: "RELAY_SCOPE_UNAVAILABLE",
      errorMessage: "Could not establish relay scope for this verified target.",
    },
  }
}

// All local policy and credential checks have succeeded. Only the delivery that
// commits the paid-work claim may install its target session on the relay.
export function prepareRelayRegistration({
  scanId,
  targetType,
  relayConfig,
  minted,
  sessionBinding,
  authorization,
}: {
  scanId: string
  targetType: string
  relayConfig: RelayRuntimeConfig
  minted: ReturnType<typeof mintScanRelayGrant>
  sessionBinding?: RelaySessionBinding
  authorization: AuthenticatedAssessmentAuthorization | null
}) {
  const attempt = { ownerId: randomUUID(), grant: minted.grant }
  return {
    context: { url: relayConfig.url, grant: minted.grant },
    async activate() {
      try {
        await registerRelayGrant(scanId, minted.grant, relayConfig, sessionBinding, attempt.ownerId)
        await addScanEvent(scanId, "relay_scope", "info", "Relay scope granted", {
          hosts: minted.scope.hosts,
          methods: minted.scope.methods,
          maxRequests: minted.scope.maxRequests,
        })
        if (sessionBinding && authorization) {
          const credentialScope =
            authorization.credentialScope &&
            typeof authorization.credentialScope === "object" &&
            !Array.isArray(authorization.credentialScope)
              ? (authorization.credentialScope as Record<string, unknown>)
              : {}
          await addScanEvent(
            scanId,
            "auth_session_bound",
            "info",
            "Pre-created test session bound to the relay scope",
            {
              authorizationRef: authorization.planId,
              credentialId: authorization.credentialId,
              sessionHosts: sessionBinding.hosts,
              sessionExpiresAt: new Date(sessionBinding.exp).toISOString(),
              ...(typeof credentialScope.role === "string"
                ? { credentialRole: credentialScope.role }
                : {}),
            }
          )
        }
        return null
      } catch (grantError) {
        // A lost response can mean registration succeeded. Revoke this owner only.
        await revokeFailedRelayRegistration(scanId, relayConfig, attempt, grantError)
        return relaySetupFailure(scanId, targetType, grantError, true)
      }
    },
    async finish(workspaceId: string) {
      try {
        const entries = await fetchRelayAudit(scanId, relayConfig)
        if (entries.length) {
          const uploaded = await uploadEncryptedArtifact({
            workspaceId,
            ownerId: scanId,
            type: "relay_audit",
            content: JSON.stringify(entries),
            contentType: "application/json",
          })
          await addScanEvent(scanId, "relay_audit", "info", "Relay audit trail captured", {
            entries: entries.length,
            storageUri: uploaded.storageUri,
          })
        }
      } catch (auditErr) {
        logger.warn("Failed to persist relay audit", {
          scanId,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        })
      } finally {
        await revokeRelayGrant(scanId, relayConfig, attempt)
      }
    },
  }
}
