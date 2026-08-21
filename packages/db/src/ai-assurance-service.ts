import { createHash } from "node:crypto"
import { logger } from "@lyrashield/logger"
import { prisma } from "./client"
import { withWorkspaceRLS } from "./rls"

export const AI_ASSURANCE_CONTROL_IDS = [
  "vibe-34",
  "vibe-35",
  "vibe-36",
  "vibe-43",
  "vibe-46",
  "vibe-48",
  "vibe-50",
] as const

export type AiAssuranceControlId = (typeof AI_ASSURANCE_CONTROL_IDS)[number]

export type AiAssuranceState =
  | "NOT_ASSESSED"
  | "EVIDENCE_REQUIRED"
  | "EVIDENCE_SUBMITTED"
  | "EVIDENCE_ACCEPTED"
  | "EVIDENCE_EXPIRED"
  | "NOT_APPLICABLE"

export const CONTROL_EVIDENCE_VERSION_STATUSES = [
  "SUBMITTED",
  "ACCEPTED",
  "REJECTED",
  "NOT_APPLICABLE",
] as const

export type ControlEvidenceVersionStatus = (typeof CONTROL_EVIDENCE_VERSION_STATUSES)[number]

export interface ArtifactManifestItem {
  id: string
  filename: string
  mediaType: string
  byteLength: number
  storageUri: string
  checksum: string
  encryptionKeyRef: string
}

export interface ControlEvidenceVersionSummary {
  id: string
  controlEvidenceId: string
  version: number
  status: ControlEvidenceVersionStatus
  attestation: string
  reviewedById: string | null
  reviewedAt: Date | null
  expiresAt: Date | null
  artifactManifest: ArtifactManifestItem[]
  checksum: string
  createdById: string
  createdAt: Date
}

export interface CreateControlEvidenceInput {
  workspaceId: string
  targetId: string
  controlId: string
  attestation: string
  expiresAt: Date | null
  createdById: string
}

export interface ReviseControlEvidenceInput {
  workspaceId: string
  evidenceId: string
  attestation: string
  expiresAt: Date | null
  createdById: string
}

export interface ReviewControlEvidenceInput {
  workspaceId: string
  evidenceId: string
  versionId: string
  status: "ACCEPTED" | "REJECTED"
  reviewerId: string
}

export interface ListControlEvidenceInput {
  workspaceId: string
  targetId: string
}

export interface AddControlEvidenceArtifactsInput {
  workspaceId: string
  evidenceId: string
  manifestItems: ArtifactManifestItem[]
  createdById: string
}

export interface MarkControlEvidenceNotApplicableInput {
  workspaceId: string
  targetId: string
  controlId: string
  reason: string
  createdById: string
}

export interface ControlEvidenceWithVersion {
  id: string
  workspaceId: string
  targetId: string
  controlId: string
  currentVersion: ControlEvidenceVersionSummary | null
}

export const MAX_CONTROL_EVIDENCE_ARTIFACTS = 5
export const MAX_CONTROL_EVIDENCE_ARTIFACT_BYTES = 20 * 1024 * 1024

const ARTIFACT_MEDIA_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain",
}

export function validateControlEvidenceArtifacts(
  existing: ArtifactManifestItem[],
  incoming: ArtifactManifestItem[]
): void {
  if (incoming.length === 0) throw new Error("EVIDENCE_ARTIFACT_REQUIRED")
  if (existing.length + incoming.length > MAX_CONTROL_EVIDENCE_ARTIFACTS) {
    throw new Error("EVIDENCE_ARTIFACT_COUNT_EXCEEDED")
  }

  const totalBytes = [...existing, ...incoming].reduce(
    (total, artifact) => total + artifact.byteLength,
    0
  )
  if (totalBytes > MAX_CONTROL_EVIDENCE_ARTIFACT_BYTES) {
    throw new Error("EVIDENCE_ARTIFACT_SIZE_EXCEEDED")
  }

  for (const artifact of incoming) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(artifact.filename)) {
      throw new Error("EVIDENCE_ARTIFACT_FILENAME_INVALID")
    }
    const extension = artifact.filename.slice(artifact.filename.lastIndexOf(".")).toLowerCase()
    if (!extension || ARTIFACT_MEDIA_TYPES[extension] !== artifact.mediaType) {
      throw new Error("EVIDENCE_ARTIFACT_MEDIA_TYPE_INVALID")
    }
    if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength <= 0) {
      throw new Error("EVIDENCE_ARTIFACT_SIZE_INVALID")
    }
  }
}

function isValidControlId(controlId: string): controlId is AiAssuranceControlId {
  return (AI_ASSURANCE_CONTROL_IDS as readonly string[]).includes(controlId)
}

type AiAssuranceAuditAction =
  | "ai_assurance.evidence.created"
  | "ai_assurance.evidence.revised"
  | "ai_assurance.evidence.reviewed"
  | "ai_assurance.evidence.artifacts_added"
  | "ai_assurance.evidence.not_applicable"

async function logAiAssuranceAuditBestEffort(
  workspaceId: string,
  actorUserId: string,
  action: AiAssuranceAuditAction,
  resourceId: string,
  metadata?: Record<string, unknown>
) {
  try {
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId,
        action,
        resourceType: "controlEvidence",
        resourceId,
        metadata,
      },
    })
  } catch (error) {
    logger.error("Failed to create audit log", {
      workspaceId,
      action,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]"
  }

  const obj = value as Record<string, unknown>
  const sorted = Object.keys(obj).sort()
  const entries = sorted.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
  return "{" + entries.join(",") + "}"
}

function computeVersionChecksum(fields: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(fields)).digest("hex")
}

function buildVersionChecksum(
  version: number,
  status: ControlEvidenceVersionStatus,
  attestation: string,
  expiresAt: Date | null,
  artifactManifest: ArtifactManifestItem[],
  createdById: string,
  reviewedById: string | null,
  reviewedAt: Date | null
): string {
  return computeVersionChecksum({
    version,
    status,
    attestation,
    expiresAt: expiresAt?.toISOString() ?? null,
    artifactManifest,
    createdById,
    reviewedById,
    reviewedAt: reviewedAt?.toISOString() ?? null,
  })
}

export async function createControlEvidence(
  input: CreateControlEvidenceInput
): Promise<ControlEvidenceVersionSummary> {
  if (!isValidControlId(input.controlId)) {
    throw new Error(`Invalid control evidence control ID: ${input.controlId}`)
  }

  const { version, evidenceId } = await withWorkspaceRLS(input.workspaceId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.targetId}:${input.controlId}`}, 0))`

    let evidence = await tx.controlEvidence.findFirst({
      where: {
        workspaceId: input.workspaceId,
        targetId: input.targetId,
        controlId: input.controlId,
      },
    })

    if (!evidence) {
      evidence = await tx.controlEvidence.create({
        data: {
          workspaceId: input.workspaceId,
          targetId: input.targetId,
          controlId: input.controlId,
        },
      })
    }

    const nextVersion =
      (await tx.controlEvidenceVersion.count({
        where: { controlEvidenceId: evidence.id },
      })) + 1

    const checksum = buildVersionChecksum(
      nextVersion,
      "SUBMITTED",
      input.attestation,
      input.expiresAt,
      [],
      input.createdById,
      null,
      null
    )

    const versionVal = await tx.controlEvidenceVersion.create({
      data: {
        controlEvidenceId: evidence.id,
        version: nextVersion,
        status: "SUBMITTED",
        attestation: input.attestation,
        expiresAt: input.expiresAt,
        artifactManifest: [],
        checksum,
        createdById: input.createdById,
      },
    })

    await tx.controlEvidence.update({
      where: { id: evidence.id },
      data: { currentVersionId: versionVal.id },
    })

    return { version: versionVal, evidenceId: evidence.id }
  })

  await logAiAssuranceAuditBestEffort(
    input.workspaceId,
    input.createdById,
    "ai_assurance.evidence.created",
    evidenceId,
    { versionId: version.id, controlId: input.controlId }
  )

  return version as unknown as ControlEvidenceVersionSummary
}

/**
 * Records a target/control-scoped exception as its own immutable evidence
 * version. The reason is deliberately retained as attestation text so reports
 * can explain why a required control was excluded.
 */
export async function markControlEvidenceNotApplicable(
  input: MarkControlEvidenceNotApplicableInput
): Promise<ControlEvidenceVersionSummary> {
  if (!isValidControlId(input.controlId)) {
    throw new Error(`Invalid control evidence control ID: ${input.controlId}`)
  }
  if (!input.reason.trim()) throw new Error("EVIDENCE_NOT_APPLICABLE_REASON_REQUIRED")

  const { version, evidenceId } = await withWorkspaceRLS(input.workspaceId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.targetId}:${input.controlId}`}, 0))`

    let evidence = await tx.controlEvidence.findFirst({
      where: {
        workspaceId: input.workspaceId,
        targetId: input.targetId,
        controlId: input.controlId,
      },
    })
    if (!evidence) {
      evidence = await tx.controlEvidence.create({
        data: {
          workspaceId: input.workspaceId,
          targetId: input.targetId,
          controlId: input.controlId,
        },
      })
    }

    const nextVersion =
      (await tx.controlEvidenceVersion.count({ where: { controlEvidenceId: evidence.id } })) + 1
    const checksum = buildVersionChecksum(
      nextVersion,
      "NOT_APPLICABLE",
      input.reason.trim(),
      null,
      [],
      input.createdById,
      null,
      null
    )
    const versionVal = await tx.controlEvidenceVersion.create({
      data: {
        controlEvidenceId: evidence.id,
        version: nextVersion,
        status: "NOT_APPLICABLE",
        attestation: input.reason.trim(),
        expiresAt: null,
        artifactManifest: [],
        checksum,
        createdById: input.createdById,
      },
    })
    await tx.controlEvidence.update({
      where: { id: evidence.id },
      data: { currentVersionId: versionVal.id },
    })
    return { version: versionVal, evidenceId: evidence.id }
  })
  await logAiAssuranceAuditBestEffort(
    input.workspaceId,
    input.createdById,
    "ai_assurance.evidence.not_applicable",
    evidenceId,
    { versionId: version.id, controlId: input.controlId }
  )
  return version as unknown as ControlEvidenceVersionSummary
}

export async function reviseControlEvidence(
  input: ReviseControlEvidenceInput
): Promise<ControlEvidenceVersionSummary> {
  const { version, evidenceId, previousVersionId } = await withWorkspaceRLS(
    input.workspaceId,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.evidenceId}, 0))`

      const evidence = await tx.controlEvidence.findFirst({
        where: {
          id: input.evidenceId,
          workspaceId: input.workspaceId,
        },
      })

      if (!evidence || !evidence.currentVersionId) {
        throw new Error("EVIDENCE_NOT_FOUND")
      }

      const current = await tx.controlEvidenceVersion.findUnique({
        where: { id: evidence.currentVersionId },
      })

      if (!current) {
        throw new Error("EVIDENCE_VERSION_NOT_FOUND")
      }

      const nextVersion =
        (await tx.controlEvidenceVersion.count({
          where: { controlEvidenceId: evidence.id },
        })) + 1

      const artifactManifest = (current.artifactManifest as unknown as ArtifactManifestItem[]) ?? []

      const checksum = buildVersionChecksum(
        nextVersion,
        "SUBMITTED",
        input.attestation,
        input.expiresAt,
        artifactManifest,
        input.createdById,
        null,
        null
      )

      const versionVal = await tx.controlEvidenceVersion.create({
        data: {
          controlEvidenceId: evidence.id,
          version: nextVersion,
          status: "SUBMITTED",
          attestation: input.attestation,
          expiresAt: input.expiresAt,
          artifactManifest,
          checksum,
          createdById: input.createdById,
        },
      })

      await tx.controlEvidence.update({
        where: { id: evidence.id },
        data: { currentVersionId: versionVal.id },
      })

      return {
        version: versionVal,
        evidenceId: evidence.id,
        previousVersionId: current.id,
      }
    }
  )

  await logAiAssuranceAuditBestEffort(
    input.workspaceId,
    input.createdById,
    "ai_assurance.evidence.revised",
    evidenceId,
    { versionId: version.id, previousVersionId }
  )

  return version as unknown as ControlEvidenceVersionSummary
}

export async function reviewControlEvidence(
  input: ReviewControlEvidenceInput
): Promise<ControlEvidenceVersionSummary> {
  const { version, evidenceId } = await withWorkspaceRLS(input.workspaceId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.evidenceId}, 0))`

    const evidence = await tx.controlEvidence.findFirst({
      where: {
        id: input.evidenceId,
        workspaceId: input.workspaceId,
      },
    })

    if (!evidence || !evidence.currentVersionId) {
      throw new Error("EVIDENCE_NOT_FOUND")
    }

    if (evidence.currentVersionId !== input.versionId) {
      throw new Error("EVIDENCE_VERSION_STALE")
    }

    const current = await tx.controlEvidenceVersion.findUnique({
      where: { id: evidence.currentVersionId },
    })

    if (!current) {
      throw new Error("EVIDENCE_VERSION_NOT_FOUND")
    }

    if (current.status !== "SUBMITTED") {
      throw new Error("EVIDENCE_VERSION_NOT_REVIEWABLE")
    }

    const nextVersion =
      (await tx.controlEvidenceVersion.count({
        where: { controlEvidenceId: evidence.id },
      })) + 1

    const reviewedAt = new Date()
    const artifactManifest = (current.artifactManifest as unknown as ArtifactManifestItem[]) ?? []

    const checksum = buildVersionChecksum(
      nextVersion,
      input.status,
      current.attestation,
      current.expiresAt,
      artifactManifest,
      input.reviewerId,
      input.reviewerId,
      reviewedAt
    )

    const versionVal = await tx.controlEvidenceVersion.create({
      data: {
        controlEvidenceId: evidence.id,
        version: nextVersion,
        status: input.status,
        attestation: current.attestation,
        expiresAt: current.expiresAt,
        reviewedById: input.reviewerId,
        reviewedAt,
        artifactManifest,
        checksum,
        createdById: input.reviewerId,
      },
    })

    await tx.controlEvidence.update({
      where: { id: evidence.id },
      data: { currentVersionId: versionVal.id },
    })

    return { version: versionVal, evidenceId: evidence.id }
  })

  await logAiAssuranceAuditBestEffort(
    input.workspaceId,
    input.reviewerId,
    "ai_assurance.evidence.reviewed",
    evidenceId,
    { versionId: version.id, status: input.status }
  )

  return version as unknown as ControlEvidenceVersionSummary
}

export async function acceptControlEvidence(input: {
  workspaceId: string
  evidenceId: string
  versionId: string
  reviewerId: string
}): Promise<ControlEvidenceVersionSummary> {
  return reviewControlEvidence({ ...input, status: "ACCEPTED" })
}

export async function rejectControlEvidence(input: {
  workspaceId: string
  evidenceId: string
  versionId: string
  reviewerId: string
}): Promise<ControlEvidenceVersionSummary> {
  return reviewControlEvidence({ ...input, status: "REJECTED" })
}

export async function listControlEvidence(
  input: ListControlEvidenceInput
): Promise<ControlEvidenceWithVersion[]> {
  return withWorkspaceRLS(input.workspaceId, async (tx) => {
    const evidences = await tx.controlEvidence.findMany({
      where: {
        workspaceId: input.workspaceId,
        targetId: input.targetId,
      },
      select: {
        id: true,
        workspaceId: true,
        targetId: true,
        controlId: true,
        currentVersionId: true,
      },
    })

    const versionIds = evidences
      .map((e) => e.currentVersionId)
      .filter((id): id is string => typeof id === "string")

    const versions =
      versionIds.length === 0
        ? []
        : await tx.controlEvidenceVersion.findMany({
            where: { id: { in: versionIds } },
          })

    const versionById = new Map(versions.map((v) => [v.id, v]))

    return evidences.map((e) => ({
      id: e.id,
      workspaceId: e.workspaceId,
      targetId: e.targetId,
      controlId: e.controlId,
      currentVersion: e.currentVersionId
        ? ((versionById.get(e.currentVersionId) as unknown as
            ControlEvidenceVersionSummary | undefined) ?? null)
        : null,
    }))
  })
}

export async function addControlEvidenceArtifacts(
  input: AddControlEvidenceArtifactsInput
): Promise<ControlEvidenceVersionSummary> {
  const { version, evidenceId } = await withWorkspaceRLS(input.workspaceId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.evidenceId}, 0))`

    const evidence = await tx.controlEvidence.findFirst({
      where: {
        id: input.evidenceId,
        workspaceId: input.workspaceId,
      },
    })

    if (!evidence || !evidence.currentVersionId) {
      throw new Error("EVIDENCE_NOT_FOUND")
    }

    const current = await tx.controlEvidenceVersion.findUnique({
      where: { id: evidence.currentVersionId },
    })

    if (!current) {
      throw new Error("EVIDENCE_VERSION_NOT_FOUND")
    }

    const nextVersion =
      (await tx.controlEvidenceVersion.count({
        where: { controlEvidenceId: evidence.id },
      })) + 1

    const existingManifest = (current.artifactManifest as unknown as ArtifactManifestItem[]) ?? []
    validateControlEvidenceArtifacts(existingManifest, input.manifestItems)
    const artifactManifest = [...existingManifest, ...input.manifestItems]

    const checksum = buildVersionChecksum(
      nextVersion,
      "SUBMITTED",
      current.attestation,
      current.expiresAt,
      artifactManifest,
      input.createdById,
      null,
      null
    )

    const versionVal = await tx.controlEvidenceVersion.create({
      data: {
        controlEvidenceId: evidence.id,
        version: nextVersion,
        status: "SUBMITTED",
        attestation: current.attestation,
        expiresAt: current.expiresAt,
        reviewedById: null,
        reviewedAt: null,
        artifactManifest,
        checksum,
        createdById: input.createdById,
      },
    })

    await tx.controlEvidence.update({
      where: { id: evidence.id },
      data: { currentVersionId: versionVal.id },
    })

    return { version: versionVal, evidenceId: evidence.id }
  })

  await logAiAssuranceAuditBestEffort(
    input.workspaceId,
    input.createdById,
    "ai_assurance.evidence.artifacts_added",
    evidenceId,
    { versionId: version.id, artifactCount: input.manifestItems.length }
  )

  return version as unknown as ControlEvidenceVersionSummary
}

export function aiAssuranceStateForVersion(
  version: ControlEvidenceVersionSummary | null | undefined
): AiAssuranceState {
  if (!version) return "EVIDENCE_REQUIRED"
  if (version.status === "NOT_APPLICABLE") return "NOT_APPLICABLE"
  if (version.status !== "ACCEPTED") {
    if (version.status === "SUBMITTED") return "EVIDENCE_SUBMITTED"
    if (version.status === "REJECTED") return "EVIDENCE_REQUIRED"
    return "EVIDENCE_REQUIRED"
  }
  if (version.expiresAt && version.expiresAt <= new Date()) {
    return "EVIDENCE_EXPIRED"
  }
  return "EVIDENCE_ACCEPTED"
}
