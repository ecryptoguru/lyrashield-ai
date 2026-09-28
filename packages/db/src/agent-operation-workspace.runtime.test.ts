import { randomUUID } from "node:crypto"
import { PrismaPg } from "@prisma/adapter-pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "./generated/prisma"

const ownerUrl = process.env.DATABASE_URL
const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
const owner = ownerUrl
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) })
  : undefined
const runtime = runtimeUrl
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl }) })
  : undefined
const suffix = randomUUID().replace(/-/g, "")
const workspaceA = `agent-fk-a-${suffix}`
const workspaceB = `agent-fk-b-${suffix}`
const userId = `agent-fk-user-${suffix}`

if (!ownerUrl || !runtimeUrl) {
  console.warn(
    "[agent-operation-workspace.runtime] SKIPPED: requires disposable DATABASE_URL and RLS_RUNTIME_DATABASE_URL"
  )
}

describe.skipIf(!ownerUrl || !runtimeUrl)("agent operation connection workspace FK", () => {
  let connectionA = ""
  let connectionB = ""

  beforeAll(async () => {
    if (!owner || !runtime || !ownerUrl || !runtimeUrl) return
    const ownerDatabase = new URL(ownerUrl)
    const runtimeDatabase = new URL(runtimeUrl)
    if (
      ownerDatabase.hostname !== "127.0.0.1" ||
      runtimeDatabase.hostname !== "127.0.0.1" ||
      ownerDatabase.port !== runtimeDatabase.port ||
      ownerDatabase.pathname !== runtimeDatabase.pathname ||
      !ownerDatabase.pathname.startsWith("/v22_agent_fk_")
    ) {
      throw new Error("Agent operation FK runtime test requires the same disposable local database")
    }

    const [role] = await runtime.$queryRaw<Array<{ superuser: boolean; bypass: boolean }>>`
      SELECT rolsuper AS superuser, rolbypassrls AS bypass
      FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ superuser: false, bypass: false })

    const [constraint] = await owner.$queryRaw<Array<{ installed: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'agent_operations_connectionId_workspaceId_fkey'
      ) AS installed`
    expect(constraint?.installed).toBe(true)

    await owner.user.create({
      data: { id: userId, name: "Agent FK test", email: `${userId}@example.invalid` },
    })
    await owner.workspace.createMany({
      data: [
        { id: workspaceA, name: "Agent FK A", slug: workspaceA },
        { id: workspaceB, name: "Agent FK B", slug: workspaceB },
      ],
    })
    const [first, second] = await Promise.all([
      owner.agentConnection.create({
        data: { workspaceId: workspaceA, userId, clientType: "test" },
      }),
      owner.agentConnection.create({
        data: { workspaceId: workspaceB, userId, clientType: "test" },
      }),
    ])
    connectionA = first.id
    connectionB = second.id
  })

  afterAll(async () => {
    try {
      if (owner) {
        await owner.workspace.deleteMany({ where: { id: { in: [workspaceA, workspaceB] } } })
        await owner.user.deleteMany({ where: { id: userId } })
      }
    } finally {
      await owner?.$disconnect()
      await runtime?.$disconnect()
    }
  })

  it("rejects cross-workspace connections under runtime RLS and preserves valid cascade behavior", async () => {
    if (!owner || !runtime || !connectionA || !connectionB) {
      throw new Error("Agent operation FK fixtures were not created")
    }

    await expect(
      runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceA}, true)`
        await tx.agentOperation.create({
          data: {
            workspaceId: workspaceA,
            connectionId: connectionB,
            principalType: "OAUTH_CONNECTION",
            principalId: connectionB,
            operationName: "test.cross-workspace",
            idempotencyKey: suffix,
            inputHash: suffix,
          },
        })
      })
    ).rejects.toMatchObject({ code: "P2003" })

    const [bound, connectionless] = await runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceA}, true)`
      const bound = await tx.agentOperation.create({
        data: {
          workspaceId: workspaceA,
          connectionId: connectionA,
          principalType: "OAUTH_CONNECTION",
          principalId: connectionA,
          operationName: "test.valid",
          idempotencyKey: suffix,
          inputHash: suffix,
        },
      })
      const connectionless = await tx.agentOperation.create({
        data: {
          workspaceId: workspaceA,
          principalType: "API_KEY",
          principalId: `key-${suffix}`,
          operationName: "test.connectionless",
          idempotencyKey: suffix,
          inputHash: suffix,
        },
      })
      return [bound, connectionless] as const
    })

    expect(
      await runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceB}, true)`
        return tx.agentOperation.findMany({ where: { id: { in: [bound.id, connectionless.id] } } })
      })
    ).toEqual([])

    await owner.agentConnection.delete({ where: { id: connectionA } })
    expect(await owner.agentOperation.findUnique({ where: { id: bound.id } })).toBeNull()
    expect(
      await owner.agentOperation.findUnique({ where: { id: connectionless.id } })
    ).not.toBeNull()
  })
})
