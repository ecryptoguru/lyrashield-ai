import type { AuthSession, WorkspaceContext } from "@lyrashield/auth/server"
import type { Target, resolveScanAttachments } from "@lyrashield/db"
import type { CreateScanInputSchema } from "@lyrashield/types"
import type { z } from "zod"
import type { SetupAuthorityEvidence } from "../../../../lib/setup-health-authority"

export type ScanSetupInput = z.output<typeof CreateScanInputSchema>

export function emptySetupEvidence(): SetupAuthorityEvidence {
  return {
    intent: null,
    actor: "UNAVAILABLE",
    target: "UNAVAILABLE",
    connection: "UNAVAILABLE",
    source: "UNAVAILABLE",
    policy: "UNAVAILABLE",
    budget: "UNAVAILABLE",
    entitlement: "UNAVAILABLE",
    attachments: "UNAVAILABLE",
    authorization: "UNAVAILABLE",
    relay: "UNAVAILABLE",
    network: "UNAVAILABLE",
  }
}

export function captureSetupIntent(evidence: SetupAuthorityEvidence, input: ScanSetupInput): void {
  evidence.intent = {
    workspaceId: input.workspaceId,
    targetId: input.targetId,
    goal: input.goal,
    mode: input.mode,
    workflow: input.workflow ?? "REVIEW_TARGET",
    policyId: input.policyId ?? null,
    engineBudgetCeilingUsd: input.engineBudgetCeilingUsd ?? null,
    baseRef: input.baseRef ?? null,
    headRef: input.headRef ?? null,
    attachmentIds: input.attachmentIds ?? [],
    authorizationRef: input.authorizationRef ?? null,
  }
  evidence.authorization = input.workflow === "AUTHENTICATED_ASSESSMENT" ? "UNAVAILABLE" : null
}

export function captureSetupActor(
  evidence: SetupAuthorityEvidence,
  session: AuthSession,
  workspace: WorkspaceContext | undefined
): void {
  if (!workspace?.member) return
  const oauth = session.oauth
  evidence.actor = {
    userId: session.userId,
    member: {
      id: workspace.member.id,
      role: workspace.member.role,
      status: workspace.member.status,
      updatedAt: workspace.member.updatedAt,
    },
    credential: session.apiKey
      ? { kind: "API_KEY", id: session.apiKey.keyId, scopes: [...session.apiKey.scopes].sort() }
      : oauth
        ? {
            kind: "OAUTH",
            connectionId: oauth.connectionId ?? null,
            authorizationVersion: oauth.authorizationVersion ?? null,
            expiresAt: oauth.expiresAt ?? null,
            scopes: [...oauth.scopes].sort(),
            allowedOperations: [...(oauth.allowedOperations ?? [])].sort(),
            allowedProfiles: [...(oauth.allowedProfiles ?? [])].sort(),
            allowedTargetIds: [...(oauth.allowedTargetIds ?? [])].sort(),
            allTargets: oauth.allTargets ?? false,
          }
        : { kind: "BROWSER" },
  }
}

export function captureSetupTarget(evidence: SetupAuthorityEvidence, target: Target): void {
  evidence.target = {
    id: target.id,
    type: target.type,
    status: target.status,
    environment: target.environment,
    url: target.url,
    apiSpecUrl: target.apiSpecUrl,
    repoProvider: target.repoProvider,
    repoOwner: target.repoOwner,
    repoName: target.repoName,
    repoFullName: target.repoFullName,
    installationId: target.installationId,
    branch: target.branch,
    updatedAt: target.updatedAt,
  }
}

export function captureSetupAttachments(
  evidence: SetupAuthorityEvidence,
  attachments: Awaited<ReturnType<typeof resolveScanAttachments>>
): void {
  evidence.attachments = attachments.map((attachment) => ({
    id: attachment.id,
    checksum: attachment.checksum,
    status: attachment.status,
    byteLength: attachment.byteLength,
    mediaType: attachment.mediaType,
    createdAt: attachment.createdAt,
  }))
}
