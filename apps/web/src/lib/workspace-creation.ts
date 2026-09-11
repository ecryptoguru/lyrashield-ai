import { randomUUID } from "node:crypto"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"
import { startTrial } from "@lyrashield/billing"
import type { WorkspaceMode } from "@lyrashield/types"

export interface CreatedWorkspace {
  id: string
  name: string
  slug: string
  mode: string
  plan: string
  trialStarted: boolean
  trialAlreadyUsed: boolean
  trialEndsAt: string | null
}

/**
 * Create a workspace with its owner membership, default policy, and trial.
 *
 * Shared by POST /api/workspaces and first-run onboarding (W2-01): the
 * onboarding flow must reuse the same workspace-creation service so a default
 * workspace is created exactly once with the same policy and trial semantics
 * as an explicit creation.
 */
export async function createWorkspaceWithTrial(input: {
  userId: string
  name: string
  mode: WorkspaceMode
}): Promise<CreatedWorkspace> {
  const slug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  if (!slug) throw new Error("INVALID_NAME")

  const workspaceId = randomUUID()
  // Bind the account context too: the trial's BillingAccount/UsageRecord rows
  // are account-owned — if this workspace's attribution slot is already taken
  // the row is created account-only (workspaceId NULL) and needs the account
  // RLS policy, not the workspace one.
  const { result, trial } = await withWorkspaceRLS(
    workspaceId,
    async (tx) => {
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

      const trial = await startTrial(workspace.id, input.userId, tx)
      return { result: workspace, trial }
    },
    { accountId: input.userId }
  )

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

/**
 * Reuse an authorized active workspace for first-run onboarding, or create a
 * default one exactly once (W2-01).
 *
 * Concurrent tabs and retries converge through the workspace slug's unique
 * constraint: the losing creation re-reads memberships instead of creating a
 * second workspace or trial.
 */
export async function ensureOnboardingWorkspace(
  userId: string,
  displayName: string | null | undefined
): Promise<string> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId, status: "active", workspace: { deletedAt: null } },
    orderBy: { createdAt: "asc" },
    select: { workspaceId: true },
  })
  if (memberships.length > 0) return memberships[0]!.workspaceId

  const name = displayName?.trim() ? `${displayName.trim()}'s workspace` : "My workspace"
  try {
    const workspace = await createWorkspaceWithTrial({ userId, name, mode: "VIBE" })
    return workspace.id
  } catch (error) {
    // A concurrent tab created the default workspace first: adopt it rather
    // than duplicating the workspace or trial.
    if (isPrismaUniqueError(error)) {
      const adopted = await prisma.workspaceMember.findFirst({
        where: { userId, status: "active", workspace: { deletedAt: null } },
        orderBy: { createdAt: "asc" },
        select: { workspaceId: true },
      })
      if (adopted) return adopted.workspaceId
    }
    throw error
  }
}

function isPrismaUniqueError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  )
}
