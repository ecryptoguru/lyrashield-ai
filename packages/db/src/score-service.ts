import { randomBytes } from "node:crypto"
import { computeScore, SCORE_MODEL_VERSION, type ScoreGrade } from "@lyrashield/score"
import { prisma } from "./client"
import { logger } from "@lyrashield/logger"

const SCORE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SHARE_SCOPE = "agentic pentest + SCA + secrets"
const BASE32 = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

export interface ScorecardPayload {
  grade: ScoreGrade
  scope: string
  scannedAt: string
  modelVersion: string
  resolvedFindings: number
}

function randomBase32(length: number): string {
  const bytes = randomBytes(length)
  return Array.from(bytes, (byte) => BASE32[byte % BASE32.length]).join("")
}

function scoreInput(
  findings: Array<{ severity: string; status: string; verified: boolean; category: string | null }>
) {
  return findings.map((finding) => ({
    severity: finding.severity as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO",
    status: finding.status as
      | "OPEN"
      | "FIX_READY"
      | "PR_OPENED"
      | "TICKET_CREATED"
      | "FIXED_PENDING_RETEST"
      | "FIXED"
      | "ACCEPTED_RISK"
      | "FALSE_POSITIVE"
      | "DUPLICATE",
    verified: finding.verified,
    activeSecret: finding.category?.toLowerCase().includes("secret") ?? false,
  }))
}

/** Completes a verified scan and creates its immutable score snapshot atomically. */
export async function completeScanWithScore(scanId: string, summary: string | null) {
  const outcome = await prisma.$transaction(async (tx) => {
    const scan = await tx.scan.findUnique({
      where: { id: scanId },
      include: {
        target: { select: { id: true, projectId: true, branch: true } },
      },
    })
    if (!scan || !scan.target) throw new Error("Scan or target not found")

    const existing = await tx.scoreSnapshot.findUnique({ where: { scanId } })
    if (existing) return { scan, snapshot: existing, created: false }
    if (scan.status !== "VERIFYING") throw new Error(`Cannot complete scan from ${scan.status}`)

    const findings = await tx.finding.findMany({
      where: { targetId: scan.targetId, workspaceId: scan.workspaceId, deletedAt: null },
      select: { severity: true, status: true, verified: true, category: true },
    })
    const triaged = findings.filter(
      (finding) => finding.status === "ACCEPTED_RISK" || finding.status === "FALSE_POSITIVE"
    ).length
    const result = computeScore(scoreInput(findings), {
      mode: scan.mode,
      isDefaultBranch: scan.target.branch !== null,
    })
    const shareEligible =
      result.shareEligible && (findings.length === 0 || triaged / findings.length <= 0.25)
    const previous = await tx.scoreSnapshot.findFirst({
      where: { targetId: scan.target.id },
      orderBy: { computedAt: "desc" },
      select: { score: true },
    })
    const now = new Date()
    const snapshot = await tx.scoreSnapshot.create({
      data: {
        workspaceId: scan.workspaceId,
        targetId: scan.target.id,
        scanId,
        modelVersion: SCORE_MODEL_VERSION,
        score: result.score,
        grade: result.grade,
        breakdown: {
          ...result.breakdown,
          triagedRatio: findings.length ? triaged / findings.length : 0,
        },
        scanMode: scan.mode,
        shareEligible,
        computedAt: now,
        expiresAt: new Date(now.getTime() + SCORE_TTL_MS),
      },
    })
    const updated = await tx.scan.update({
      where: { id: scan.id },
      data: {
        status: "COMPLETED",
        summary: summary ?? undefined,
        endedAt: now,
        riskScoreBefore: previous?.score,
        riskScoreAfter: result.score,
      },
    })
    if (scan.target.projectId) {
      const minimum = await tx.scoreSnapshot.aggregate({
        where: { target: { projectId: scan.target.projectId }, expiresAt: { gt: now } },
        _min: { score: true },
      })
      await tx.project.update({
        where: { id: scan.target.projectId },
        data: { riskScore: minimum._min.score ?? 100 },
      })
    }
    return { scan: updated, snapshot, created: true }
  })

  if (outcome.created) {
    await prisma.scanEvent.create({
      data: {
        scanId,
        stage: "completed",
        level: "info",
        message: "Scan status: COMPLETED",
        metadata: { score: outcome.snapshot.score, grade: outcome.snapshot.grade },
      },
    })
    logger.info("Score snapshot created", {
      scanId,
      score: outcome.snapshot.score,
      grade: outcome.snapshot.grade,
    })
  }
  return outcome
}

export async function getOrCreateReferralCode(userId: string) {
  const existing = await prisma.referralCode.findUnique({ where: { userId } })
  if (existing) return existing
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.referralCode.create({ data: { userId, code: randomBase32(8) } })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Unique constraint")) throw error
    }
  }
  throw new Error("Unable to allocate referral code")
}

export async function createScorecardShare(targetId: string, workspaceId: string, userId: string) {
  const snapshot = await prisma.scoreSnapshot.findFirst({
    where: { targetId, workspaceId, shareEligible: true, expiresAt: { gt: new Date() } },
    orderBy: { computedAt: "desc" },
  })
  if (!snapshot) throw new Error("No current shareable score for this target")
  const resolvedFindings = await prisma.finding.count({
    where: {
      targetId,
      workspaceId,
      status: "FIXED",
      retests: { some: { status: "passed" } },
      deletedAt: null,
    },
  })
  const referralCode = await getOrCreateReferralCode(userId)
  const publicPayload: ScorecardPayload = {
    grade: snapshot.grade,
    scope: SHARE_SCOPE,
    scannedAt: snapshot.computedAt.toISOString(),
    modelVersion: snapshot.modelVersion,
    resolvedFindings,
  }
  const share = await prisma.scorecardShare.create({
    data: {
      snapshotId: snapshot.id,
      slug: randomBase32(16),
      publicPayload,
      referralCodeId: referralCode.id,
      createdById: userId,
    },
  })
  await prisma.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "scorecard.share.created",
      resourceType: "scorecardShare",
      resourceId: share.id,
    },
  })
  return { share, referralCode: referralCode.code }
}

export async function revokeScorecardShare(id: string, workspaceId: string, userId: string) {
  const share = await prisma.scorecardShare.findFirst({ where: { id, snapshot: { workspaceId } } })
  if (!share) return null
  const updated = await prisma.scorecardShare.update({
    where: { id },
    data: { revokedAt: new Date() },
  })
  await prisma.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "scorecard.share.revoked",
      resourceType: "scorecardShare",
      resourceId: id,
    },
  })
  return updated
}

export async function getPublicScorecard(slug: string) {
  const share = await prisma.scorecardShare.findFirst({
    where: { slug, revokedAt: null, snapshot: { expiresAt: { gt: new Date() } } },
    select: { id: true, publicPayload: true, referralCode: { select: { code: true } } },
  })
  if (!share) return null
  await prisma.scorecardShare.update({
    where: { id: share.id },
    data: { viewCount: { increment: 1 } },
  })
  return {
    payload: share.publicPayload as unknown as ScorecardPayload,
    referralCode: share.referralCode?.code ?? null,
  }
}

export async function attributeReferral(code: string, referredUserId: string, ipHash?: string) {
  const referral = await prisma.referralCode.findUnique({ where: { code } })
  if (!referral || referral.userId === referredUserId) return null
  return prisma.referralAttribution.upsert({
    where: { referredUserId },
    create: { codeId: referral.id, referredUserId, source: "scorecard", ipHash },
    update: {},
  })
}

/** Awards both workspaces exactly once when a referred owner completes a real scan. */
export async function qualifyReferralForWorkspace(workspaceId: string) {
  const owner = await prisma.workspaceMember.findFirst({
    where: { workspaceId, role: "OWNER", status: "active" },
  })
  if (!owner) return null
  const attribution = await prisma.referralAttribution.findFirst({
    where: { referredUserId: owner.userId, status: "PENDING" },
    include: { code: true },
  })
  if (!attribution || attribution.code.userId === owner.userId) return null
  const referrerWorkspace = await prisma.workspaceMember.findFirst({
    where: { userId: attribution.code.userId, role: "OWNER", status: "active" },
    select: { workspaceId: true },
  })
  if (!referrerWorkspace) return null

  const [recipient] = await prisma.$transaction(async (tx) => {
    const current = await tx.referralAttribution.findUnique({ where: { id: attribution.id } })
    if (!current || current.status !== "PENDING") return [null]
    const recipientReward = await tx.usageRecord.upsert({
      where: { idempotencyKey: attribution.id },
      create: {
        workspaceId,
        kind: "referral_bonus",
        quantity: 30,
        idempotencyKey: attribution.id,
        metadata: { denomination: "agent_minutes", side: "referred" },
      },
      update: {},
    })
    await tx.usageRecord.upsert({
      where: { idempotencyKey: `${attribution.id}:referrer` },
      create: {
        workspaceId: referrerWorkspace.workspaceId,
        kind: "referral_bonus",
        quantity: 30,
        idempotencyKey: `${attribution.id}:referrer`,
        metadata: { denomination: "agent_minutes", side: "referrer" },
      },
      update: {},
    })
    await tx.referralAttribution.update({
      where: { id: attribution.id },
      data: { status: "REWARDED", qualifiedAt: new Date(), rewardRecordId: recipientReward.id },
    })
    return [recipientReward]
  })
  if (recipient)
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: owner.userId,
        action: "referral.rewarded",
        resourceType: "referralAttribution",
        resourceId: attribution.id,
      },
    })
  return recipient
}
