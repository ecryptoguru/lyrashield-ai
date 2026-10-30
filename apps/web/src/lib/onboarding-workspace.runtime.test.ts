import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"
import * as creation from "./workspace-creation"
import { chooseOrCreateOnboardingWorkspace, listOnboardingWorkspaces } from "./onboarding-workspace"
import { getOrCreateOnboardingState } from "./onboarding-state"

const enabled = process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1"
describe.skipIf(!enabled)("atomic onboarding workspace selection", () => {
  beforeAll(async () => {
    const [role] = await prisma.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
  })
  async function user() {
    const id = randomUUID()
    await prisma.user.create({ data: { id, email: `${id}@example.test`, name: "Onboarding" } })
    return { id, state: await getOrCreateOnboardingState(id) }
  }
  it("concurrent tabs create one workspace, policy, membership, trial and selection", async () => {
    const owner = await user()
    const choose = () =>
      chooseOrCreateOnboardingWorkspace(owner.id, {
        kind: "create",
        name: `Concurrent ${randomUUID()}`,
        expectedUpdatedAt: owner.state.updatedAt.toISOString(),
      })
    const results = await Promise.all([choose(), choose()])
    expect(results[0].state.workspaceId).toBe(results[1].state.workspaceId)
    expect(results.filter((result) => result.trialStarted)).toHaveLength(1)
    const members = await prisma.workspaceMember.findMany({ where: { userId: owner.id } })
    expect(members).toHaveLength(1)
    const workspaceId = members[0]!.workspaceId
    await withWorkspaceRLS(
      workspaceId,
      async (tx) => {
        expect(await tx.policy.count({ where: { workspaceId } })).toBe(1)
        expect(
          await tx.usageRecord.count({ where: { accountId: owner.id, kind: "trial_grant" } })
        ).toBe(1)
      },
      { accountId: owner.id }
    )
    expect(
      (await prisma.onboardingState.findUnique({ where: { userId: owner.id } }))?.workspaceId
    ).toBe(workspaceId)
  })
  it("selects the explicit eligible Developer membership without creating a workspace or trial", async () => {
    const owner = await user()
    const existing = await creation.createWorkspaceWithTrial({
      userId: owner.id,
      name: `Existing ${randomUUID()}`,
      mode: "VIBE",
    })
    const member = await user()
    await prisma.workspaceMember.create({
      data: { workspaceId: existing.id, userId: member.id, role: "DEVELOPER", status: "active" },
    })
    const result = await chooseOrCreateOnboardingWorkspace(member.id, {
      kind: "select",
      workspaceId: existing.id,
      expectedUpdatedAt: member.state.updatedAt.toISOString(),
    })
    expect(result.state.workspaceId).toBe(existing.id)
    expect(result.workspace.role).toBe("DEVELOPER")
    expect(result.trialStarted).toBe(false)
    expect((await prisma.user.findUnique({ where: { id: member.id } }))?.trialStartedAt).toBeNull()
    expect(await prisma.workspaceMember.count({ where: { userId: member.id } })).toBe(1)
  })
  it.each(["VIEWER", "AUDITOR", "BILLING_ADMIN"] as const)(
    "allows %s when the operational permission contract grants setup actions",
    async (role) => {
      const owner = await user()
      const existing = await creation.createWorkspaceWithTrial({
        userId: owner.id,
        name: `Eligible ${randomUUID()}`,
        mode: "VIBE",
      })
      const member = await user()
      await prisma.workspaceMember.create({
        data: { workspaceId: existing.id, userId: member.id, role, status: "active" },
      })
      const result = await chooseOrCreateOnboardingWorkspace(member.id, {
        kind: "select",
        workspaceId: existing.id,
        expectedUpdatedAt: member.state.updatedAt.toISOString(),
      })
      expect(result.workspace.role).toBe(role)
      expect(result.state.workspaceId).toBe(existing.id)
    }
  )
  it.each(["inactive", "foreign", "deleted"] as const)(
    "rejects %s workspace selection",
    async (boundary) => {
      const owner = await user()
      const existing = await creation.createWorkspaceWithTrial({
        userId: owner.id,
        name: `Excluded ${randomUUID()}`,
        mode: "VIBE",
      })
      const member = await user()
      if (boundary !== "foreign")
        await prisma.workspaceMember.create({
          data: {
            workspaceId: existing.id,
            userId: member.id,
            role: "DEVELOPER",
            status: boundary === "inactive" ? "inactive" : "active",
          },
        })
      if (boundary === "deleted")
        await prisma.workspace.update({
          where: { id: existing.id },
          data: { deletedAt: new Date() },
        })
      await expect(
        chooseOrCreateOnboardingWorkspace(member.id, {
          kind: "select",
          workspaceId: existing.id,
          expectedUpdatedAt: member.state.updatedAt.toISOString(),
        })
      ).rejects.toThrow("WORKSPACE_UNAVAILABLE")
      expect(
        (await prisma.onboardingState.findUnique({ where: { userId: member.id } }))?.workspaceId
      ).toBeNull()
    }
  )
  it("clears invalid target progress when replacing a revoked workspace", async () => {
    const member = await user()
    const old = await creation.createWorkspaceWithTrial({
      userId: member.id,
      name: `Revoked ${randomUUID()}`,
      mode: "VIBE",
    })
    await prisma.workspaceMember.updateMany({
      where: { workspaceId: old.id, userId: member.id },
      data: { status: "inactive" },
    })
    const state = await prisma.onboardingState.update({
      where: { userId: member.id },
      data: {
        workspaceId: old.id,
        targetId: "old-target",
        currentStep: 3,
        selectedGoal: "LAUNCH_REVIEW",
      },
    })
    const result = await chooseOrCreateOnboardingWorkspace(member.id, {
      kind: "create",
      name: `Replacement ${randomUUID()}`,
      expectedUpdatedAt: state.updatedAt.toISOString(),
    })
    expect(result.state).toMatchObject({
      currentStep: 1,
      targetId: null,
      selectedGoal: "LAUNCH_REVIEW",
    })
    expect(result.state.workspaceId).not.toBe(old.id)
    expect(result.trialStarted).toBe(false)
  })
  it("lists action-eligible active memberships without exposing inactive, deleted or foreign options", async () => {
    const member = await user()
    const first = await creation.createWorkspaceWithTrial({
      userId: member.id,
      name: `Zulu ${randomUUID()}`,
      mode: "VIBE",
    })
    const second = await creation.createWorkspaceWithTrial({
      userId: member.id,
      name: `Alpha ${randomUUID()}`,
      mode: "VIBE",
    })
    const inactive = await creation.createWorkspaceWithTrial({
      userId: member.id,
      name: `Inactive ${randomUUID()}`,
      mode: "VIBE",
    })
    await prisma.workspaceMember.updateMany({
      where: { workspaceId: inactive.id, userId: member.id },
      data: { status: "inactive" },
    })
    const deleted = await creation.createWorkspaceWithTrial({
      userId: member.id,
      name: `Deleted ${randomUUID()}`,
      mode: "VIBE",
    })
    await prisma.workspace.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } })
    const foreignUser = await user()
    await creation.createWorkspaceWithTrial({
      userId: foreignUser.id,
      name: `Foreign ${randomUUID()}`,
      mode: "VIBE",
    })
    expect(await listOnboardingWorkspaces(member.id)).toEqual([
      { id: second.id, name: second.name, role: "OWNER" },
      { id: first.id, name: first.name, role: "OWNER" },
    ])
  })
  it("rolls back a workspace and trial when selection fails, then permits a retry", async () => {
    const owner = await user()
    const billing = await import("@lyrashield/billing")
    const real = billing.startTrial
    const start = vi.spyOn(billing, "startTrial").mockImplementationOnce(async (...args) => {
      await real(...args)
      throw new Error("Injected failure after grant")
    })
    const input = {
      kind: "create" as const,
      name: `Rollback ${randomUUID()}`,
      expectedUpdatedAt: owner.state.updatedAt.toISOString(),
    }
    try {
      await expect(chooseOrCreateOnboardingWorkspace(owner.id, input)).rejects.toThrow(
        "Injected failure"
      )
      expect(await prisma.workspaceMember.count({ where: { userId: owner.id } })).toBe(0)
      expect((await prisma.user.findUnique({ where: { id: owner.id } }))?.trialStartedAt).toBeNull()
      expect(
        (await prisma.onboardingState.findUnique({ where: { userId: owner.id } }))?.workspaceId
      ).toBeNull()
      expect((await chooseOrCreateOnboardingWorkspace(owner.id, input)).trialStarted).toBe(true)
    } finally {
      start.mockRestore()
    }
  })
  it("rejects stale progress before creating anything", async () => {
    const owner = await user()
    await prisma.onboardingState.update({
      where: { userId: owner.id },
      data: {
        selectedGoal: "SECURITY_CHECK",
        updatedAt: new Date(owner.state.updatedAt.getTime() + 1000),
      },
    })
    await expect(
      chooseOrCreateOnboardingWorkspace(owner.id, {
        kind: "create",
        name: "Stale",
        expectedUpdatedAt: owner.state.updatedAt.toISOString(),
      })
    ).rejects.toThrow("ONBOARDING_CHANGED")
    expect(await prisma.workspaceMember.count({ where: { userId: owner.id } })).toBe(0)
  })
  it("preserves ordinary explicit creates as separate workspaces", async () => {
    const owner = await user()
    const first = await creation.createWorkspaceWithTrial({
      userId: owner.id,
      name: `Explicit ${randomUUID()}`,
      mode: "VIBE",
    })
    const second = await creation.createWorkspaceWithTrial({
      userId: owner.id,
      name: `Explicit ${randomUUID()}`,
      mode: "VIBE",
    })
    expect(first.id).not.toBe(second.id)
    expect(first.trialStarted).toBe(true)
    expect(second.trialStarted).toBe(false)
    expect(await prisma.workspaceMember.count({ where: { userId: owner.id } })).toBe(2)
  })
})
