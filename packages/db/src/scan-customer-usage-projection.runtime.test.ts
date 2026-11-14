import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaPg } from "@prisma/adapter-pg"
import { buildScanExecutionPlan } from "@lyrashield/types"
import { PrismaClient, Prisma } from "./generated/prisma"
import { getCustomerScanUsageProjection } from "./scan-customer-usage-projection"

// Hoisting runs this guard before imports can construct the runtime client.
// The fixture pairs the privileged DATABASE_SYSTEM_URL role with the restricted
// DATABASE_URL role, so bind those two through the shared disposable-pair guard.
await vi.hoisted(async () => {
  const owner = process.env.DATABASE_SYSTEM_URL
  const runtime = process.env.DATABASE_URL
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1" || !owner || !runtime) return
  const { assertDisposableDatabasePair } =
    await import("../../../.github/scripts/vitest-database-env.mjs")
  assertDisposableDatabasePair({
    ...process.env,
    DATABASE_URL: owner,
    RLS_RUNTIME_DATABASE_URL: runtime,
  })
})

const enabled = process.env.SCAN_USAGE_RLS_RUNTIME_TEST === "1"
const ownerUrl = process.env.DATABASE_SYSTEM_URL
const runtimeUrl = process.env.DATABASE_URL
const suffix = randomUUID()
const workspaceId = `usage-workspace-${suffix}`
const sponsorId = `usage-sponsor-${suffix}`
let scanId = ""
let receiptKey = ""
let fixtureCreated = false
const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) })
const runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl }) })

describe.skipIf(!enabled)("customer scan usage with account RLS", () => {
  beforeAll(async () => {
    expect(process.env.LYRASHIELD_TEST_DB_DISPOSABLE).toBe("1")
    for (const connection of [ownerUrl, runtimeUrl]) {
      const url = new URL(connection ?? "")
      expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname)
      expect(url.pathname).toBe("/lyrashield")
    }
    const [role] = await runtime.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })

    await owner.user.create({
      data: { id: sponsorId, name: "Usage test", email: `${sponsorId}@example.invalid` },
    })
    await owner.workspace.create({
      data: { id: workspaceId, name: "Usage test", slug: workspaceId },
    })
    const target = await owner.target.create({
      data: { workspaceId, name: "Usage test", type: "REPO" },
    })
    const scan = await owner.scan.create({
      data: {
        workspaceId,
        targetId: target.id,
        createdById: sponsorId,
        sponsorAccountId: sponsorId,
        goal: "TEST_APP",
        mode: "STANDARD",
        status: "COMPLETED",
        accountingVersion: 2,
        accountingSettledAt: new Date(),
        actualCostCents: 483,
        executionPlan: buildScanExecutionPlan({
          targetType: "REPO",
          mode: "STANDARD",
        }) as Prisma.InputJsonValue,
      },
    })
    scanId = scan.id
    receiptKey = `${workspaceId}:${scanId}:engine_run`
    await owner.usageRecord.create({
      data: {
        workspaceId,
        accountId: sponsorId,
        idempotencyKey: receiptKey,
        kind: "agent_minutes",
        quantity: 3,
        metadata: { scanId, accountId: sponsorId },
      },
    })
    fixtureCreated = true
  })

  afterAll(async () => {
    if (fixtureCreated) {
      await owner.usageRecord.deleteMany({ where: { accountId: sponsorId } })
      await owner.workspace.deleteMany({ where: { id: workspaceId } })
      await owner.user.deleteMany({ where: { id: sponsorId } })
    }
    await owner.$disconnect()
    await runtime.$disconnect()
  })

  it("reads only the persisted sponsor's account receipt", async () => {
    const value = await getCustomerScanUsageProjection({
      workspaceId,
      scanId,
      actorUserId: sponsorId,
    })
    expect(value).toEqual({ state: "reconciled", chargedMinutes: 3 })
    expect(JSON.stringify(value)).not.toMatch(/483|cost|usd/i)
    await expect(
      getCustomerScanUsageProjection({ workspaceId, scanId, actorUserId: "another-account" })
    ).resolves.toBeNull()
    await runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`
      await tx.$executeRaw`SELECT set_config('app.current_account_id', 'another-account', true)`
      expect(await tx.usageRecord.count({ where: { workspaceId } })).toBe(0)
    })
    await expect(
      getCustomerScanUsageProjection({
        workspaceId: "another-workspace",
        scanId,
        actorUserId: sponsorId,
      })
    ).resolves.toBeNull()
  })

  it("rejects a receipt whose persisted scan binding changes", async () => {
    await owner.usageRecord.update({
      where: { idempotencyKey: receiptKey },
      data: { metadata: { scanId: "another-scan", accountId: sponsorId } },
    })
    await expect(
      getCustomerScanUsageProjection({ workspaceId, scanId, actorUserId: sponsorId })
    ).resolves.toEqual({ state: "unavailable", chargedMinutes: null })
  })
})
