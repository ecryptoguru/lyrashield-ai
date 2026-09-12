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
 * Used by POST /api/workspaces so every explicit creation receives the same
 * default policy and trial semantics.
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
