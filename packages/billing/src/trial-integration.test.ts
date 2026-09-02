import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"
import { startTrial, isTrialAvailable } from "./trial"

// Explicit opt-in: exercise the real scoped client against a disposable local database.
describe.skipIf(process.env.TRIAL_INTEGRATION_TEST !== "1")(
  "trial transactions with restricted PostgreSQL",
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL!)
      if (!["127.0.0.1", "localhost"].includes(url.hostname))
        throw new Error("Local database required")
      const [role] = await prisma.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
    })

    async function fixture() {
      const userId = randomUUID()
      const workspaceId = randomUUID()
      await prisma.user.create({
        data: { id: userId, name: "Trial test", email: `${userId}@example.test` },
      })
      await prisma.workspace.create({
        data: {
          id: workspaceId,
          name: "Trial test",
          slug: workspaceId,
          members: { create: { userId, role: "OWNER", status: "active" } },
        },
      })
      return { userId, workspaceId }
    }

    it("serializes simultaneous claims for two workspaces and survives membership removal", async () => {
      const { userId, workspaceId } = await fixture()
      const second = randomUUID()
      await prisma.workspace.create({ data: { id: second, name: "Second", slug: second } })
      const results = await Promise.all([
        startTrial(workspaceId, userId),
        startTrial(second, userId),
      ])
      expect(results.filter((result) => result.started)).toHaveLength(1)
      expect(results.filter((result) => result.alreadyUsed)).toHaveLength(1)
      await prisma.workspaceMember.deleteMany({ where: { userId } })
      expect(await isTrialAvailable(second, userId)).toBe(false)
      const total = await Promise.all(
        [workspaceId, second].map((id) =>
          withWorkspaceRLS(id, (tx) =>
            tx.usageRecord.count({ where: { workspaceId: id, kind: "trial_grant" } })
          )
        )
      )
      expect(total.reduce((sum, count) => sum + count, 0)).toBe(1)
    })

    it("rolls back workspace, grant, and user claim together, allowing a slug retry", async () => {
      const userId = randomUUID()
      const workspaceId = randomUUID()
      await prisma.user.create({
        data: { id: userId, name: "Rollback", email: `${userId}@example.test` },
      })
      await expect(
        withWorkspaceRLS(workspaceId, async (tx) => {
          await tx.workspace.create({
            data: { id: workspaceId, name: "Rollback", slug: workspaceId },
          })
          await startTrial(workspaceId, userId, tx)
          throw new Error("transaction failed")
        })
      ).rejects.toThrow("transaction failed")
      expect(await prisma.workspace.findUnique({ where: { id: workspaceId } })).toBeNull()
      expect((await prisma.user.findUnique({ where: { id: userId } }))?.trialStartedAt).toBeNull()
      await withWorkspaceRLS(workspaceId, async (tx) => {
        await tx.workspace.create({ data: { id: workspaceId, name: "Retry", slug: workspaceId } })
        expect((await startTrial(workspaceId, userId, tx)).started).toBe(true)
      })
    })

    it("repeated starts grant only once", async () => {
      const { userId, workspaceId } = await fixture()
      const results = await Promise.all([
        startTrial(workspaceId, userId),
        startTrial(workspaceId, userId),
      ])
      expect(results.filter((result) => result.started)).toHaveLength(1)
      expect(results.every((result) => !result.alreadyUsed)).toBe(true)
    })

    it("does not overwrite an upgrade committed between trial read and conditional write", async () => {
      const { userId, workspaceId } = await fixture()
      await expect(
        withWorkspaceRLS(workspaceId, (tx) =>
          startTrial(workspaceId, userId, {
            $executeRaw: tx.$executeRaw.bind(tx),
            user: tx.user,
            billingAccount: tx.billingAccount,
            usageRecord: tx.usageRecord,
            workspace: {
              findUnique: tx.workspace.findUnique.bind(tx.workspace),
              findFirst: tx.workspace.findFirst.bind(tx.workspace),
              updateMany: async (args: Parameters<typeof tx.workspace.updateMany>[0]) => {
                await withWorkspaceRLS(workspaceId, async (upgrade) => {
                  await upgrade.billingAccount.create({
                    data: { workspaceId, currentPlan: "PRO", status: "active" },
                  })
                  await upgrade.workspace.update({
                    where: { id: workspaceId },
                    data: { plan: "PRO", deepAllowed: true },
                  })
                })
                return tx.workspace.updateMany(args)
              },
            },
          } as typeof tx)
        )
      ).rejects.toThrow("TRIAL_PAID_PLAN")
      expect((await prisma.user.findUnique({ where: { id: userId } }))?.trialStartedAt).toBeNull()
      expect((await prisma.workspace.findUnique({ where: { id: workspaceId } }))?.plan).toBe("PRO")
      expect(
        await withWorkspaceRLS(workspaceId, (tx) =>
          tx.usageRecord.count({ where: { workspaceId } })
        )
      ).toBe(0)
    })

    it("rejects paid workspaces without consuming the user claim", async () => {
      const { userId, workspaceId } = await fixture()
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { plan: "PRO", deepAllowed: true },
      })
      await expect(startTrial(workspaceId, userId)).rejects.toThrow("TRIAL_PAID_PLAN")
      expect((await prisma.user.findUnique({ where: { id: userId } }))?.trialStartedAt).toBeNull()
      expect((await prisma.workspace.findUnique({ where: { id: workspaceId } }))?.plan).toBe("PRO")
    })
  }
)
