import { createHash } from "node:crypto"
import { logger } from "@lyrashield/logger"
import { prisma } from "./client"
import { withWorkspaceRLS } from "./rls"

export type AiSystemProfileInput = {
  systemName: string
  systemPurpose: string
  modelProviders: Array<{ provider: string; model: string; deployment: string | null }>
  dataClasses: string[]
  dataSources: string[]
  storageSystems: string[]
  toolIntegrations: string[]
  retentionSummary: string | null
  humanOversightSummary: string | null
}

const MAX_SCALAR_LENGTH = 4_000
const MAX_ARRAY_ENTRIES = 50

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`
}

function validateScalar(value: string | null, field: string, required = false): void {
  if (required && !value?.trim())
    throw new Error(`AI_SYSTEM_PROFILE_${field.toUpperCase()}_REQUIRED`)
  if (value && value.length > MAX_SCALAR_LENGTH)
    throw new Error(`AI_SYSTEM_PROFILE_${field.toUpperCase()}_TOO_LONG`)
}

function validateArray(values: string[], field: string, required = false): void {
  if ((!Array.isArray(values) || values.length === 0) && required) {
    throw new Error(`AI_SYSTEM_PROFILE_${field.toUpperCase()}_REQUIRED`)
  }
  if (!Array.isArray(values) || values.length > MAX_ARRAY_ENTRIES) {
    throw new Error(`AI_SYSTEM_PROFILE_${field.toUpperCase()}_INVALID`)
  }
  for (const value of values) validateScalar(value, field, true)
}

export function validateAiSystemProfile(input: AiSystemProfileInput): void {
  validateScalar(input.systemName, "system_name", true)
  validateScalar(input.systemPurpose, "system_purpose", true)
  validateArray(input.dataClasses, "data_classes", true)
  validateArray(input.dataSources, "data_sources")
  validateArray(input.storageSystems, "storage_systems", true)
  validateArray(input.toolIntegrations, "tool_integrations")
  validateScalar(input.retentionSummary, "retention_summary")
  validateScalar(input.humanOversightSummary, "human_oversight_summary", true)
  if (input.dataSources.length > 0 && !input.retentionSummary?.trim()) {
    throw new Error("AI_SYSTEM_PROFILE_RETENTION_SUMMARY_REQUIRED")
  }
  if (
    !Array.isArray(input.modelProviders) ||
    input.modelProviders.length === 0 ||
    input.modelProviders.length > MAX_ARRAY_ENTRIES
  ) {
    throw new Error("AI_SYSTEM_PROFILE_MODEL_PROVIDERS_INVALID")
  }
  for (const provider of input.modelProviders) {
    validateScalar(provider.provider, "provider", true)
    validateScalar(provider.model, "model", true)
    validateScalar(provider.deployment, "deployment")
  }
}

export function buildAiSystemInventorySummary(profile: AiSystemProfileInput): string {
  return [
    "Customer-declared inventory summary (not independently verified)",
    `System: ${profile.systemName}`,
    `Purpose: ${profile.systemPurpose}`,
    `Providers: ${profile.modelProviders.map((provider) => `${provider.provider}/${provider.model}`).join(", ")}`,
    `Data sources: ${profile.dataSources.join(", ") || "none declared"}`,
    `Storage: ${profile.storageSystems.join(", ")}`,
    `Tools: ${profile.toolIntegrations.join(", ") || "none declared"}`,
    `Retention: ${profile.retentionSummary ?? "not declared"}`,
    `Human oversight: ${profile.humanOversightSummary ?? "not declared"}`,
  ].join("\n")
}

export async function upsertAiSystemProfile(input: {
  workspaceId: string
  targetId: string
  createdById: string
  profile: AiSystemProfileInput
}) {
  validateAiSystemProfile(input.profile)
  const checksum = createHash("sha256").update(canonicalize(input.profile)).digest("hex")

  const { updated, created, version } = await withWorkspaceRLS(input.workspaceId, async (tx) => {
    const target = await tx.target.findFirst({
      where: { id: input.targetId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    })
    if (!target) throw new Error("TARGET_NOT_FOUND")

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.targetId}, 0))`
    let record = await tx.aiSystemProfile.findFirst({
      where: { workspaceId: input.workspaceId, targetId: input.targetId },
    })
    if (!record) {
      record = await tx.aiSystemProfile.create({
        data: {
          workspaceId: input.workspaceId,
          targetId: input.targetId,
          profile: input.profile,
          createdById: input.createdById,
          updatedById: input.createdById,
        },
      })
    }

    const versionVal = record.version + (record.currentVersionId ? 1 : 0)
    const createdVal = await tx.aiSystemProfileVersion.create({
      data: {
        aiSystemProfileId: record.id,
        version: versionVal,
        profile: input.profile,
        checksum,
        createdById: input.createdById,
      },
    })
    const updatedVal = await tx.aiSystemProfile.update({
      where: { id: record.id },
      data: {
        version: versionVal,
        profile: input.profile,
        currentVersionId: createdVal.id,
        updatedById: input.createdById,
      },
    })
    return { updated: updatedVal, created: createdVal, version: versionVal }
  })
  try {
    await prisma.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.createdById,
        action: "ai_assurance.profile.version_created",
        resourceType: "aiSystemProfile",
        resourceId: updated.id,
        metadata: { versionId: created.id, version, checksum },
      },
    })
  } catch (error) {
    logger.error("Failed to create audit log", {
      workspaceId: input.workspaceId,
      action: "ai_assurance.profile.version_created",
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return {
    profile: updated,
    version: created,
    inventorySummary: buildAiSystemInventorySummary(input.profile),
  }
}

export async function getAiSystemProfile(workspaceId: string, targetId: string) {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const target = await tx.target.findFirst({
      where: { id: targetId, workspaceId, deletedAt: null },
      select: { id: true },
    })
    if (!target) return null
    return tx.aiSystemProfile.findFirst({
      where: { workspaceId, targetId },
      include: { currentVersion: true },
    })
  })
}
