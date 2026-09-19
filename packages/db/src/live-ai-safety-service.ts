import { randomBytes } from "node:crypto"
import { resolveTxt } from "node:dns/promises"
import {
  normalizeDomainForProof,
  verifyDomainProofToken,
  type TxtResolver,
} from "@lyrashield/security"
import { LiveAiSafetyPlanSchema, type LiveAiSafetyPlan } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import { prisma } from "./client"
import { withWorkspaceRLS } from "./rls"

const DNS_CHALLENGE_TTL_MS = 60 * 60 * 1000
const DOMAIN_PROOF_TTL_MS = 90 * 24 * 60 * 60 * 1000

export class LiveAiSafetyError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/**
 * Authenticated-assessment staging beta: a test session must be pre-created
 * and short-lived. The bound from record creation to expiry is capped so a
 * long-lived or production credential can never satisfy the check.
 */
export const AUTH_ASSESSMENT_SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000

/**
 * The verified authorization context for an AUTHENTICATED_ASSESSMENT plan —
 * metadata only. `credentialVaultRef`/`credentialScope` stay references into
 * the secret store; the session material itself is resolved at the trusted
 * relay boundary and never enters the plan, logs, or this record's callers.
 */
export interface AuthenticatedAssessmentAuthorization {
  planId: string
  approvedHost: string
  incidentContact: string
  credentialId: string
  credentialKind: string
  credentialVaultRef: string
  credentialScope: unknown
  credentialExpiresAt: Date
  /** The authorization cannot outlive the recorded domain proof. */
  domainVerificationExpiresAt: Date
}

/**
 * Verify that `authorizationRef` names a recorded, scoped authorization for
 * the AUTHENTICATED_ASSESSMENT workflow on this exact target. The artifact is
 * a READY `LiveAiSafetyPlan` row — it already records the approved host, the
 * bound domain-verification proof, the staging consent (target environment),
 * the incident contact, and the scoped test-session credential reference.
 * Both the scan-create route and the worker execution-time re-check call
 * this; any revoked, expired, or mismatched input fails closed.
 */
export async function resolveAuthenticatedAssessmentAuthorization(input: {
  workspaceId: string
  targetId: string
  authorizationRef: string
  now?: Date
}): Promise<AuthenticatedAssessmentAuthorization> {
  const now = input.now ?? new Date()
  return withWorkspaceRLS(input.workspaceId, async (tx) => {
    const [plan, target] = await Promise.all([
      tx.liveAiSafetyPlan.findFirst({
        where: { id: input.authorizationRef, workspaceId: input.workspaceId },
        select: {
          id: true,
          targetId: true,
          status: true,
          approvedHost: true,
          authMode: true,
          credentialId: true,
          incidentContact: true,
          domainVerification: {
            select: { id: true, status: true, expiresAt: true },
          },
        },
      }),
      tx.target.findFirst({
        where: { id: input.targetId, workspaceId: input.workspaceId, deletedAt: null },
        select: { id: true, type: true, url: true, environment: true },
      }),
    ])

    if (!plan || plan.targetId !== input.targetId) {
      throw new LiveAiSafetyError("AUTH_ASSESSMENT_AUTH_NOT_FOUND")
    }
    // READY is the only admissible state — a plan that was consumed, stopped,
    // or revoked before execution is a bounded stop, not a fallback.
    if (plan.status !== "READY") {
      throw new LiveAiSafetyError("AUTH_ASSESSMENT_AUTH_NOT_READY")
    }
    if (!target) throw new LiveAiSafetyError("TARGET_NOT_FOUND")
    if (target.type !== "WEB_APP" && target.type !== "API") {
      throw new LiveAiSafetyError("AUTH_ASSESSMENT_TARGET_UNSUPPORTED")
    }
    // Production targets are never eligible for the staging beta.
    if (target.environment !== "STAGING" && target.environment !== "PREVIEW") {
      throw new LiveAiSafetyError("AUTH_ASSESSMENT_PRODUCTION_DENIED")
    }
    if (!target.url) throw new LiveAiSafetyError("AUTH_ASSESSMENT_HOST_MISMATCH")

    // The recorded authorization must cover this exact target host — domain
    // ownership alone never authorizes a different host or another workflow.
    const targetHost = normalizeDomainForProof(target.url)
    const approvedHost = normalizeDomainForProof(plan.approvedHost)
    if (!targetHost || !approvedHost || targetHost !== approvedHost) {
      throw new LiveAiSafetyError("AUTH_ASSESSMENT_HOST_MISMATCH")
    }

    const verification = plan.domainVerification
    if (!verification || verification.status !== "VERIFIED" || verification.expiresAt <= now) {
      throw new LiveAiSafetyError("DOMAIN_VERIFICATION_REQUIRED")
    }
    if (!plan.incidentContact) {
      throw new LiveAiSafetyError("AUTH_ASSESSMENT_INCIDENT_CONTACT_REQUIRED")
    }

    // Only a pre-created scoped test session may back this workflow — never a
    // production credential or an unauthenticated plan.
    if (plan.authMode !== "TEST_CREDENTIAL" || !plan.credentialId) {
      throw new LiveAiSafetyError("AUTH_ASSESSMENT_SESSION_REQUIRED")
    }
    const credential = await tx.credentialSet.findFirst({
      where: {
        id: plan.credentialId,
        workspaceId: input.workspaceId,
        OR: [{ targetId: null }, { targetId: input.targetId }],
      },
      select: {
        id: true,
        kind: true,
        vaultRef: true,
        scope: true,
        expiresAt: true,
        createdAt: true,
      },
    })
    if (!credential) throw new LiveAiSafetyError("AUTH_ASSESSMENT_SESSION_NOT_FOUND")
    if (!credential.expiresAt || credential.expiresAt <= now) {
      throw new LiveAiSafetyError("AUTH_ASSESSMENT_SESSION_EXPIRED")
    }
    if (
      credential.expiresAt.getTime() - credential.createdAt.getTime() >
      AUTH_ASSESSMENT_SESSION_MAX_LIFETIME_MS
    ) {
      throw new LiveAiSafetyError("AUTH_ASSESSMENT_SESSION_TOO_LONG")
    }

    return {
      planId: plan.id,
      approvedHost,
      incidentContact: plan.incidentContact,
      credentialId: credential.id,
      credentialKind: credential.kind,
      credentialVaultRef: credential.vaultRef,
      credentialScope: credential.scope,
      credentialExpiresAt: credential.expiresAt,
      domainVerificationExpiresAt: verification.expiresAt,
    }
  })
}

function requireDomain(value: string): string {
  const domain = normalizeDomainForProof(value)
  if (!domain) throw new LiveAiSafetyError("DOMAIN_VERIFICATION_INVALID_DOMAIN")
  return domain
}

export async function issueDnsDomainVerification(input: {
  workspaceId: string
  domain: string
  createdById: string
  now?: Date
}) {
  const domain = requireDomain(input.domain)
  const now = input.now ?? new Date()
  const token = randomBytes(32).toString("base64url")
  const expiresAt = new Date(now.getTime() + DNS_CHALLENGE_TTL_MS)

  const verification = await withWorkspaceRLS(input.workspaceId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${domain}`}, 0))`
    const existing = await tx.targetDomainVerification.findFirst({
      where: { workspaceId: input.workspaceId, domain },
      select: { id: true },
    })
    const data = {
      method: "DNS_TXT" as const,
      status: "PENDING" as const,
      challengeToken: token,
      challengeId: null,
      expiresAt,
      verifiedAt: null,
      lastCheckedAt: null,
      createdById: input.createdById,
    }
    const record = existing
      ? await tx.targetDomainVerification.update({ where: { id: existing.id }, data })
      : await tx.targetDomainVerification.create({
          data: { workspaceId: input.workspaceId, domain, ...data },
        })
    return record
  })

  try {
    await prisma.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.createdById,
        action: "target.domain_verification_requested",
        resourceType: "targetDomainVerification",
        resourceId: verification.id,
        metadata: { domain, method: "DNS_TXT", expiresAt: expiresAt.toISOString() },
      },
    })
  } catch (error) {
    logger.error("Failed to create audit log", {
      workspaceId: input.workspaceId,
      action: "target.domain_verification_requested",
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // The DNS value is public but is shown only in this issuance response; it is never logged.
  return { verification, token, expiresAt }
}

export async function verifyDnsDomainVerification(input: {
  workspaceId: string
  verificationId: string
  actorUserId: string
  now?: Date
  resolveTxt?: TxtResolver
}) {
  const now = input.now ?? new Date()
  const resolver = input.resolveTxt ?? resolveTxt
  const { updated, expiresAt } = await withWorkspaceRLS(input.workspaceId, async (tx) => {
    const verification = await tx.targetDomainVerification.findFirst({
      where: { id: input.verificationId, workspaceId: input.workspaceId, method: "DNS_TXT" },
    })
    if (!verification) throw new LiveAiSafetyError("DOMAIN_VERIFICATION_NOT_FOUND")
    if (!verification.challengeToken || verification.expiresAt <= now) {
      await tx.targetDomainVerification.update({
        where: { id: verification.id },
        data: { status: "EXPIRED", lastCheckedAt: now },
      })
      throw new LiveAiSafetyError("DOMAIN_VERIFICATION_CHALLENGE_EXPIRED")
    }

    const verified = await verifyDomainProofToken(
      verification.domain,
      verification.challengeToken,
      resolver
    )
    if (!verified) {
      await tx.targetDomainVerification.update({
        where: { id: verification.id },
        data: { lastCheckedAt: now },
      })
      throw new LiveAiSafetyError("DOMAIN_VERIFICATION_PROOF_NOT_FOUND")
    }

    const expiresAtVal = new Date(now.getTime() + DOMAIN_PROOF_TTL_MS)
    const result = await tx.targetDomainVerification
      .update({
        // DNS resolution yields control. A reissued challenge must never inherit
        // verification obtained with the previous token.
        where: {
          id: verification.id,
          workspaceId: input.workspaceId,
          challengeToken: verification.challengeToken,
          expiresAt: verification.expiresAt,
        },
        data: { status: "VERIFIED", verifiedAt: now, lastCheckedAt: now, expiresAt: expiresAtVal },
      })
      .catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "P2025"
        ) {
          throw new LiveAiSafetyError("DOMAIN_VERIFICATION_PROOF_CHANGED")
        }
        throw error
      })
    return { updated: result, expiresAt: expiresAtVal }
  })

  try {
    await prisma.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        action: "target.domain_verified",
        resourceType: "targetDomainVerification",
        resourceId: updated.id,
        metadata: {
          domain: updated.domain,
          method: updated.method,
          expiresAt: expiresAt.toISOString(),
        },
      },
    })
  } catch (error) {
    logger.error("Failed to create audit log", {
      workspaceId: input.workspaceId,
      action: "target.domain_verified",
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return updated
}

export async function upsertLiveAiSafetySettings(input: {
  workspaceId: string
  createdById: string
  incidentContact: string | null
}) {
  if (input.incidentContact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.incidentContact)) {
    throw new LiveAiSafetyError("LIVE_AI_SAFETY_INVALID_INCIDENT_CONTACT")
  }
  const settings = await withWorkspaceRLS(input.workspaceId, async (tx) => {
    const result = await tx.liveAiSafetySettings.upsert({
      where: { workspaceId: input.workspaceId },
      create: input,
      update: { incidentContact: input.incidentContact },
    })
    return result
  })
  try {
    await prisma.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.createdById,
        action: "live_ai_safety.settings_updated",
        resourceType: "liveAiSafetySettings",
        resourceId: settings.id,
      },
    })
  } catch (error) {
    logger.error("Failed to create audit log", {
      workspaceId: input.workspaceId,
      action: "live_ai_safety.settings_updated",
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return settings
}

export async function createLiveAiSafetyPlan(input: LiveAiSafetyPlan & { createdById: string }) {
  const parsed = LiveAiSafetyPlanSchema.safeParse(input)
  if (!parsed.success) throw new LiveAiSafetyError("LIVE_AI_SAFETY_INVALID_PLAN")
  const plan = parsed.data
  const endpointDomain = requireDomain(plan.endpointUrl)

  const created = await withWorkspaceRLS(plan.workspaceId, async (tx) => {
    const [workspace, target] = await Promise.all([
      tx.workspace.findUnique({ where: { id: plan.workspaceId }, select: { plan: true } }),
      tx.target.findFirst({
        where: { id: plan.targetId, workspaceId: plan.workspaceId, deletedAt: null },
        select: { id: true, type: true, url: true, environment: true },
      }),
    ])
    if (!workspace || workspace.plan === "FREE")
      throw new LiveAiSafetyError("PAID_ENTITLEMENT_REQUIRED")
    if (!target) throw new LiveAiSafetyError("TARGET_NOT_FOUND")
    if (target.type !== "WEB_APP" && target.type !== "API")
      throw new LiveAiSafetyError("LIVE_AI_SAFETY_TARGET_UNSUPPORTED")
    if (target.environment !== "PREVIEW" && target.environment !== "STAGING")
      throw new LiveAiSafetyError("LIVE_AI_SAFETY_NON_PRODUCTION_REQUIRED")
    if (!target.url || requireDomain(target.url) !== endpointDomain)
      throw new LiveAiSafetyError("LIVE_AI_SAFETY_ENDPOINT_TARGET_MISMATCH")

    const verification = await tx.targetDomainVerification.findFirst({
      where: {
        workspaceId: plan.workspaceId,
        domain: endpointDomain,
        status: "VERIFIED",
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    })
    if (!verification) throw new LiveAiSafetyError("DOMAIN_VERIFICATION_REQUIRED")

    if (plan.credentialId) {
      const credential = await tx.credentialSet.findFirst({
        where: {
          id: plan.credentialId,
          workspaceId: plan.workspaceId,
          OR: [{ targetId: null }, { targetId: plan.targetId }],
        },
        select: { id: true },
      })
      if (!credential) throw new LiveAiSafetyError("LIVE_AI_SAFETY_CREDENTIAL_NOT_FOUND")
    }

    const result = await tx.liveAiSafetyPlan.create({
      data: {
        workspaceId: plan.workspaceId,
        targetId: plan.targetId,
        domainVerificationId: verification.id,
        endpointUrl: plan.endpointUrl,
        approvedHost: plan.approvedHost,
        authMode: plan.authMode,
        credentialId: plan.credentialId ?? null,
        incidentContact: plan.incidentContact,
        maxRequests: plan.maxRequests,
        maxDurationSeconds: plan.maxDurationSeconds,
        maxResponseBytes: plan.maxResponseBytes,
        rawSampleStorage: plan.rawSampleStorage,
        cases: plan.cases,
        status: "READY",
        createdById: input.createdById,
      },
    })
    return result
  })
  try {
    await prisma.auditLog.create({
      data: {
        workspaceId: plan.workspaceId,
        actorUserId: input.createdById,
        action: "live_ai_safety.plan_created",
        resourceType: "liveAiSafetyPlan",
        resourceId: created.id,
        metadata: { targetId: plan.targetId, domain: endpointDomain, caseCount: plan.cases.length },
      },
    })
  } catch (error) {
    logger.error("Failed to create audit log", {
      workspaceId: plan.workspaceId,
      action: "live_ai_safety.plan_created",
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return created
}
