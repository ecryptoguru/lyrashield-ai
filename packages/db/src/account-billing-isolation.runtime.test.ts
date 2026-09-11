import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "./generated/prisma"
const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})
const runtime = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.RLS_RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL,
  }),
})
const id = `account-isolation-${randomUUID()}`
describe.skipIf(!process.env.RLS_RUNTIME_DATABASE_URL)(
  "account-owned billing database boundary",
  () => {
    beforeAll(async () => {
      await owner.workspace.create({ data: { id, name: id, slug: id } })
      await owner.billingAccount.create({
        data: {
          id,
          workspaceId: id,
          accountId: `${id}-A`,
          provider: "trial",
          status: "trialing",
          currentPlan: "FREE",
        },
      })
      await owner.usageRecord.create({
        data: { workspaceId: id, accountId: `${id}-A`, kind: "pool_grant", quantity: 100 },
      })
      await owner.minutePack.create({
        data: {
          workspaceId: id,
          accountId: `${id}-A`,
          minutes: 10,
          remainingMinutes: 10,
          provider: "manual",
          externalId: id,
        },
      })
    })
    afterAll(async () => {
      await owner.$disconnect()
      await runtime.$disconnect()
    })
    it("denies a coworker even when the workspace matches", async () => {
      await runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${id}, true)`
        await tx.$executeRaw`SELECT set_config('app.current_account_id', ${`${id}-B`}, true)`
        expect(await tx.billingAccount.findMany({ where: { id } })).toEqual([])
        expect(await tx.usageRecord.findMany({ where: { workspaceId: id } })).toEqual([])
        expect(await tx.minutePack.findMany({ where: { workspaceId: id } })).toEqual([])
        expect(
          (await tx.billingAccount.updateMany({ where: { id }, data: { currentPlan: "PRO" } }))
            .count
        ).toBe(0)
      })
    })
    it("allows the owning account without any workspace context", async () => {
      await runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_account_id', ${`${id}-A`}, true)`
        expect(await tx.billingAccount.count({ where: { id } })).toBe(1)
        expect(await tx.usageRecord.count({ where: { accountId: `${id}-A` } })).toBe(1)
      })
    })
  }
)
