import { createHash } from "node:crypto"
import { logger } from "@lyrashield/logger"
import { prisma } from "./client"
import { withWorkspaceRLS } from "./rls"

const MAX_SCALAR_LENGTH = 4_000
const MAX_ARRAY_ENTRIES = 50

export type ThreatModelThreat = {
  title: string
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
  description: string
  mitigation: string | null
  testPlan: string | null
  owner: string | null
  reviewDate: string | null
}

export type ThreatModelInput = {
  scope: string
  assets: string[]
  trustBoundaries: string[]
  threats: ThreatModelThreat[]
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`
}

function requireScalar(value: string | null, field: string): void {
  if (!value?.trim() || value.length > MAX_SCALAR_LENGTH) {
    throw new Error(`THREAT_MODEL_${field.toUpperCase()}_INVALID`)
  }
}

function validateList(values: string[], field: string): void {
  if (!Array.isArray(values) || values.length > MAX_ARRAY_ENTRIES) {
    throw new Error(`THREAT_MODEL_${field.toUpperCase()}_INVALID`)
  }
  for (const value of values) requireScalar(value, field)
}

export function validateThreatModel(input: ThreatModelInput): void {
  requireScalar(input.scope, "scope")
  validateList(input.assets, "assets")
  validateList(input.trustBoundaries, "trust_boundaries")
  if (!Array.isArray(input.threats) || input.threats.length > MAX_ARRAY_ENTRIES) {
    throw new Error("THREAT_MODEL_THREATS_INVALID")
  }
  for (const threat of input.threats) {
    requireScalar(threat.title, "threat_title")
    requireScalar(threat.description, "threat_description")
    if (["HIGH", "CRITICAL"].includes(threat.severity)) {
      requireScalar(threat.mitigation, "mitigation")
      requireScalar(threat.testPlan, "test_plan")
      requireScalar(threat.owner, "owner")
    }
    for (const value of [threat.mitigation, threat.testPlan, threat.owner]) {
      if (value !== null && value.length > MAX_SCALAR_LENGTH) {
        throw new Error("THREAT_MODEL_FIELD_TOO_LONG")
      }
    }
    if (threat.reviewDate !== null && Number.isNaN(Date.parse(threat.reviewDate))) {
      throw new Error("THREAT_MODEL_REVIEW_DATE_INVALID")
    }
  }
}

export function threatModelMarkdown(input: ThreatModelInput): string {
  return [
    "# Customer-declared threat model",
    "",
    "This inventory is customer-declared and not independently verified.",
    "",
    "## Scope",
    input.scope,
    "",
    "## Assets",
    ...(input.assets.length ? input.assets.map((asset) => `- ${asset}`) : ["- None declared"]),
    "",
    "## Trust boundaries",
    ...(input.trustBoundaries.length
      ? input.trustBoundaries.map((boundary) => `- ${boundary}`)
      : ["- None declared"]),
    "",
    "## Threats",
    ...(input.threats.length
      ? input.threats.flatMap((threat) => [
          `### ${threat.title} (${threat.severity})`,
          threat.description,
          `- Owner: ${threat.owner ?? "Not declared"}`,
          `- Mitigation: ${threat.mitigation ?? "Not declared"}`,
          `- Test plan: ${threat.testPlan ?? "Not declared"}`,
          `- Review date: ${threat.reviewDate ?? "Not declared"}`,
          "",
        ])
      : ["No threats declared."]),
  ].join("\n")
}

export async function saveThreatModel(input: {
  workspaceId: string
  targetId: string
  createdById: string
  content: ThreatModelInput
}) {
  validateThreatModel(input.content)
  const checksum = createHash("sha256").update(canonicalize(input.content)).digest("hex")
  const { created, modelId, version } = await withWorkspaceRLS(input.workspaceId, async (tx) => {
    const target = await tx.target.findFirst({
      where: { id: input.targetId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    })
    if (!target) throw new Error("TARGET_NOT_FOUND")
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.targetId}, 0))`
    let model = await tx.threatModel.findFirst({
      where: { workspaceId: input.workspaceId, targetId: input.targetId },
      include: { currentVersion: { select: { version: true } } },
    })
    if (!model) {
      model = await tx.threatModel.create({
        data: { workspaceId: input.workspaceId, targetId: input.targetId },
        include: { currentVersion: { select: { version: true } } },
      })
    }
    const versionVal = (model.currentVersion?.version ?? 0) + 1
    const createdVal = await tx.threatModelVersion.create({
      data: {
        threatModelId: model.id,
        version: versionVal,
        content: input.content,
        checksum,
        createdById: input.createdById,
      },
    })
    await tx.threatModel.update({ where: { id: model.id }, data: { currentVersionId: createdVal.id } })
    return { created: createdVal, modelId: model.id, version: versionVal }
  })
  try {
    await prisma.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.createdById,
        action: "ai_assurance.threat_model.version_created",
        resourceType: "threatModel",
        resourceId: modelId,
        metadata: { versionId: created.id, version, checksum },
      },
    })
  } catch (error) {
    logger.error("Failed to create audit log", {
      workspaceId: input.workspaceId,
      action: "ai_assurance.threat_model.version_created",
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return created
}

export async function getThreatModel(workspaceId: string, targetId: string) {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const target = await tx.target.findFirst({
      where: { id: targetId, workspaceId, deletedAt: null },
      select: { id: true },
    })
    if (!target) return null
    return tx.threatModel.findFirst({
      where: { workspaceId, targetId },
      include: { currentVersion: true },
    })
  })
}
