import { randomBytes } from "node:crypto"
import { createId } from "@paralleldrive/cuid2"
import { hasPermission, PERMISSIONS } from "@lyrashield/auth"
import {
  prisma,
  withWorkspaceRLS,
  lockWorkspaceMembership,
  type MemberRole,
  type ScopedTransaction,
} from "@lyrashield/db"
import { getOrCreateOnboardingState } from "./onboarding-state"
import { createWorkspaceInTransaction, isWorkspaceSlugUniqueError } from "./workspace-creation"
import type { OnboardingWorkspaceChoice } from "./onboarding-workspace-schema"

export function canUseOnboardingWorkspace(role: MemberRole): boolean {
  return (
    hasPermission(role, PERMISSIONS.target.create) && hasPermission(role, PERMISSIONS.scan.create)
  )
}

export async function listOnboardingWorkspaces(userId: string) {
  const members = await prisma.workspaceMember.findMany({
    where: { userId, status: "active", workspace: { deletedAt: null } },
    orderBy: [{ workspace: { name: "asc" } }, { id: "asc" }],
    select: { workspaceId: true, role: true, workspace: { select: { name: true } } },
  })
  return members
    .filter((member) => canUseOnboardingWorkspace(member.role))
    .map((member) => ({
      id: member.workspaceId,
      name: member.workspace.name,
      role: member.role,
    }))
}

export class OnboardingWorkspaceError extends Error {
  constructor(public code: "ONBOARDING_CHANGED" | "WORKSPACE_UNAVAILABLE") {
    super(code)
  }
}

async function eligibleWorkspace(tx: ScopedTransaction, workspaceId: string, userId: string) {
  // Membership mutations share this workspace lock; permission cannot change
  // between authorization and committing the user's onboarding selection.
  await lockWorkspaceMembership(tx, workspaceId)
  const member = await tx.workspaceMember.findFirst({
    where: { workspaceId, userId, status: "active", workspace: { deletedAt: null } },
    select: { role: true, workspace: { select: { id: true, name: true } } },
  })
  if (!member || !canUseOnboardingWorkspace(member.role)) return null
  return {
    ...member.workspace,
    role: member.role,
    canManageGitHub: hasPermission(member.role, PERMISSIONS.integration.manage),
  }
}

/** One browser-user onboarding claim, independent of names and concurrent tabs. */
export async function chooseOrCreateOnboardingWorkspace(
  userId: string,
  input: OnboardingWorkspaceChoice & { expectedUpdatedAt: string }
) {
  await getOrCreateOnboardingState(userId)
  for (let attempt = 0; ; attempt++) {
    const workspaceId = input.kind === "select" ? input.workspaceId : createId()
    try {
      const result = await withWorkspaceRLS(
        workspaceId,
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`onboarding:${userId}`}, 0))`
          await tx.$queryRaw`SELECT id FROM onboarding_states WHERE "userId" = ${userId} FOR UPDATE`
          const state = await tx.onboardingState.findUniqueOrThrow({ where: { userId } })
          if (state.workspaceId) {
            const existing = await eligibleWorkspace(tx, state.workspaceId, userId)
            if (existing) {
              if (input.kind === "select" && input.workspaceId !== existing.id)
                throw new OnboardingWorkspaceError("ONBOARDING_CHANGED")
              return { state, workspace: existing, trialStarted: false, created: false }
            }
          }
          if (state.completed || state.updatedAt.toISOString() !== input.expectedUpdatedAt)
            throw new OnboardingWorkspaceError("ONBOARDING_CHANGED")
          let workspace
          let trialStarted = false
          if (input.kind === "select") {
            workspace = await eligibleWorkspace(tx, workspaceId, userId)
            if (!workspace) throw new OnboardingWorkspaceError("WORKSPACE_UNAVAILABLE")
          } else {
            const slugBase =
              input.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "") || "workspace"
            const slug = attempt === 0 ? slugBase : `${slugBase}-${randomBytes(3).toString("hex")}`
            const created = await createWorkspaceInTransaction(
              tx,
              { userId, name: input.name, mode: "VIBE" },
              workspaceId,
              slug
            )
            workspace = {
              id: created.result.id,
              name: created.result.name,
              role: "OWNER" as const,
              canManageGitHub: true,
            }
            trialStarted = created.trial.started
          }
          const next = await tx.onboardingState.update({
            where: { userId },
            data: {
              workspaceId,
              targetId: null,
              currentStep: 1,
              updatedAt: new Date(Math.max(Date.now(), state.updatedAt.getTime() + 1)),
              skipped: false,
            },
          })
          return { state: next, workspace, trialStarted, created: input.kind === "create" }
        },
        { accountId: userId }
      )
      // Audit chain serialization owns its own transaction; never nest it in the claim.
      if (result.created)
        await prisma.auditLog.create({
          data: {
            workspaceId: result.workspace.id,
            actorUserId: userId,
            action: "workspace.created",
            resourceType: "workspace",
            resourceId: result.workspace.id,
          },
        })
      return result
    } catch (error) {
      if (attempt >= 4 || !isWorkspaceSlugUniqueError(error)) throw error
    }
  }
}
