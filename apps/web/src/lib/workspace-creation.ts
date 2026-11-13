import { randomBytes } from "node:crypto"
import { createId } from "@paralleldrive/cuid2"
import { prisma, withWorkspaceRLS, type ScopedTransaction } from "@lyrashield/db"
import { startTrial } from "@lyrashield/billing"
import type { WorkspaceMode } from "@lyrashield/types"

interface CreatedWorkspace {
  id: string
  name: string
  slug: string
  mode: string
  plan: string
  trialStarted: boolean
  trialAlreadyUsed: boolean
  trialEndsAt: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function isWorkspaceSlugTarget(value: unknown): boolean {
  return (
    (typeof value === "string" && (value === "slug" || value === "Workspace_slug_key")) ||
    (Array.isArray(value) && value.length === 1 && value[0] === "slug")
  )
}

/** True only for a known workspace slug unique constraint. */
export function isWorkspaceSlugUniqueError(error: unknown): boolean {
  const root = asRecord(error)
  if (root?.code !== "P2002") return false

  const meta = asRecord(root.meta)
  if (!meta) return false
  if (typeof meta.modelName === "string" && meta.modelName !== "Workspace") return false

  const adapterError = asRecord(meta.driverAdapterError)
  const cause = asRecord(adapterError?.cause)
  const constraint = asRecord(cause?.constraint)

  return (
    isWorkspaceSlugTarget(meta.target) ||
    isWorkspaceSlugTarget(constraint?.fields) ||
    isWorkspaceSlugTarget(constraint?.name)
  )
}

/** Shared atomic defaults and account trial claim; caller owns the scoped transaction. */
export async function createWorkspaceInTransaction(
  tx: ScopedTransaction,
  input: { userId: string; name: string; mode: WorkspaceMode },
  workspaceId: string,
  slug: string
) {
  const workspace = await tx.workspace.create({
    data: {
      id: workspaceId,
      name: input.name,
      slug,
      mode: input.mode,
      plan: "FREE",
      members: {
        create: {
          userId: input.userId,
          role: "OWNER",
          status: "active",
        },
      },
      policies: {
        create: {
          name: "Default Policy",
          description: "Default scan policy with safe settings",
          networkEgressPolicy: "target_only",
          destructiveTestsAllowed: false,
          approvalRequired: false,
          maxDurationMinutes: 60,
          piiRedactionEnabled: true,
          evidenceRetentionDays: 30,
        },
      },
    },
  })

  let trial: Awaited<ReturnType<typeof startTrial>>
  try {
    trial = await startTrial(workspace.id, input.userId, tx)
  } catch (error) {
    // A paid account may still create workspaces; it simply cannot claim a trial.
    if (!(error instanceof Error) || error.message !== "TRIAL_PAID_PLAN") throw error
    const owner = await tx.user.findUnique({
      where: { id: input.userId },
      select: { trialStartedAt: true },
    })
    trial = { started: false, alreadyUsed: Boolean(owner?.trialStartedAt), trialEndsAt: null }
  }
  return { result: workspace, trial }
}

/**
 * Create a workspace with its owner membership, default policy, and trial.
 *
 * Used by POST /api/workspaces so every explicit creation receives the same
 * default policy and trial semantics.
 */
export async function createWorkspaceWithTrial(input: {
  userId: string
  name: string
  mode: WorkspaceMode
}): Promise<CreatedWorkspace> {
  const baseSlug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  const slugBase = baseSlug || "workspace"
  const createAttempt = (workspaceId: string, slug: string) =>
    withWorkspaceRLS(
      workspaceId,
      async (tx) => {
        return createWorkspaceInTransaction(tx, input, workspaceId, slug)
      },
      { accountId: input.userId }
    )

  let created: Awaited<ReturnType<typeof createAttempt>> | null = null
  let finalSlugError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? slugBase : `${slugBase}-${randomBytes(3).toString("hex")}`
    const workspaceId = createId()
    try {
      created = await createAttempt(workspaceId, slug)
      break
    } catch (error) {
      if (!isWorkspaceSlugUniqueError(error)) throw error
      finalSlugError = error
    }
  }

  if (!created) throw finalSlugError

  const { result, trial } = created

  await prisma.auditLog.create({
    data: {
      workspaceId: result.id,
      actorUserId: input.userId,
      action: "workspace.created",
      resourceType: "workspace",
      resourceId: result.id,
    },
  })

  return {
    id: result.id,
    name: result.name,
    slug: result.slug,
    mode: result.mode,
    plan: result.plan,
    trialStarted: trial.started,
    trialAlreadyUsed: trial.alreadyUsed,
    trialEndsAt: trial.trialEndsAt?.toISOString() ?? null,
  }
}
