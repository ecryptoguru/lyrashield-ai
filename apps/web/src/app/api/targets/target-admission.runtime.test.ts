import { randomUUID } from "node:crypto"
import { PrismaClient } from "../../../../../../packages/db/src/generated/prisma"
import { assertTargetAllowed } from "@lyrashield/billing"
import {
  createBoundedPgAdapter,
  lockWorkspaceScanAdmission,
  prisma as runtime,
  withWorkspaceRLS,
} from "@lyrashield/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const ownerUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL
const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
const enabled = ownerUrl && runtimeUrl && process.env.TARGET_ADMISSION_RUNTIME_TEST === "1"
const owner = ownerUrl
  ? new PrismaClient({ adapter: createBoundedPgAdapter(ownerUrl, "db:system") })
  : undefined
const suffix = randomUUID().replace(/-/g, "")
const workspaceId = `target-cap-${suffix}`
const userId = `target-cap-user-${suffix}`
const initialTargetIds: string[] = []

if (!enabled) {
  console.warn(
    "[target-admission.runtime] SKIPPED: requires disposable owner/runtime URLs and TARGET_ADMISSION_RUNTIME_TEST=1"
  )
}

describe.skipIf(!enabled)("workspace target-cap admission on PostgreSQL", () => {
  beforeAll(async () => {
    if (!owner || !runtime || !ownerUrl || !runtimeUrl) return
    const ownerAddress = new URL(ownerUrl)
    const runtimeAddress = new URL(runtimeUrl)
    const database = decodeURIComponent(ownerAddress.pathname.slice(1))
    const disposableDatabase =
      /(?:^|[_-])(?:test|ci|disposable)(?:$|[_-])/i.test(database) ||
      ["v15_product", "lyra_v18_ci", "v22_agent_fk_ci"].includes(database) ||
      (database === "lyrashield" && process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1")
    if (
      !["127.0.0.1", "localhost"].includes(ownerAddress.hostname) ||
      !["127.0.0.1", "localhost"].includes(runtimeAddress.hostname) ||
      ownerAddress.port !== runtimeAddress.port ||
      ownerAddress.pathname !== runtimeAddress.pathname ||
      !disposableDatabase
    ) {
      throw new Error("Target admission runtime test requires the same named loopback database")
    }

    const [role] = await runtime.$queryRaw<Array<{ superuser: boolean; bypass: boolean }>>`
      SELECT rolsuper AS superuser, rolbypassrls AS bypass
      FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ superuser: false, bypass: false })

    await owner.user.create({
      data: {
        id: userId,
        name: "Target admission test",
        email: `${userId}@example.invalid`,
        trialStartedAt: new Date(),
      },
    })
    await owner.workspace.create({
      data: { id: workspaceId, name: "Target cap test", slug: workspaceId },
    })
    await owner.workspaceMember.create({
      data: { workspaceId, userId, role: "OWNER", status: "active" },
    })
    const initialTargets = await owner.target.createManyAndReturn({
      data: [0, 1].map((index) => ({
        workspaceId,
        type: "WEB_APP" as const,
        name: `Existing ${index + 1}`,
        url: `https://${workspaceId}-${index}.example.test`,
      })),
      select: { id: true },
    })
    initialTargetIds.push(...initialTargets.map((target) => target.id))
  })

  afterAll(async () => {
    try {
      if (owner) {
        await owner.$executeRaw`DELETE FROM "Workspace" WHERE id = ${workspaceId}`
        await owner.user.deleteMany({ where: { id: userId } })
      }
    } finally {
      await owner?.$disconnect()
    }
  })

  async function tryCreate(url: string): Promise<boolean> {
    return withWorkspaceRLS(
      workspaceId,
      async (tx) => {
        await lockWorkspaceScanAdmission(tx, workspaceId)
        const entitlement = await assertTargetAllowed(workspaceId, userId, tx)
        if (!entitlement.allowed) return false
        await tx.target.create({
          data: { workspaceId, type: "WEB_APP", name: "Final slot", url },
        })
        return true
      },
      { accountId: userId }
    )
  }

  it("admits one of two concurrent distinct target creates at the last slot and frees it on deletion", async () => {
    if (!owner || initialTargetIds.length !== 2) {
      throw new Error("Disposable target-cap fixtures were not created")
    }
    const results = await Promise.all([
      tryCreate(`https://${workspaceId}-concurrent-a.example.test`),
      tryCreate(`https://${workspaceId}-concurrent-b.example.test`),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(results.filter((created) => !created)).toHaveLength(1)
    expect(await owner.target.count({ where: { workspaceId, deletedAt: null } })).toBe(3)

    await owner.target.update({
      where: { id: initialTargetIds[0] },
      data: { deletedAt: new Date() },
    })
    expect(await tryCreate(`https://${workspaceId}-after-delete.example.test`)).toBe(true)
    expect(await owner.target.count({ where: { workspaceId, deletedAt: null } })).toBe(3)
  })
})
