import { randomUUID } from "node:crypto"
import { PrismaPg } from "@prisma/adapter-pg"
import { createId } from "@paralleldrive/cuid2"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "./generated/prisma"

const ownerUrl = process.env.DATABASE_URL
const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
const enabled =
  ownerUrl && runtimeUrl && process.env.INTEGRATION_CONFIG_DELETION_RUNTIME_TEST === "1"
const owner = ownerUrl
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) })
  : undefined
const runtime = runtimeUrl
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl }) })
  : undefined
const suffix = randomUUID().replace(/-/g, "")
const workspaceId = `integration-outbox-${suffix}`
const otherWorkspaceId = `integration-outbox-other-${suffix}`
const storageUri = `s3://evidence-test/evidence/${workspaceId}/integrations/${createId()}.enc`

if (!enabled) {
  console.warn(
    "[integration-config-deletion.runtime] SKIPPED: requires disposable owner/runtime URLs and INTEGRATION_CONFIG_DELETION_RUNTIME_TEST=1"
  )
}

describe.skipIf(!enabled)("integration config deletion outbox runtime authorization", () => {
  beforeAll(async () => {
    if (!owner || !runtime || !ownerUrl || !runtimeUrl) return
    const ownerAddress = new URL(ownerUrl)
    const runtimeAddress = new URL(runtimeUrl)
    const database = decodeURIComponent(ownerAddress.pathname.slice(1))
    const disposableDatabase =
      /(?:^|[_-])(?:test|ci|disposable)(?:$|[_-])/i.test(database) ||
      ["v15_product", "lyra_v18_ci", "v22_agent_fk_ci"].includes(database)
    if (
      !["127.0.0.1", "localhost"].includes(ownerAddress.hostname) ||
      !["127.0.0.1", "localhost"].includes(runtimeAddress.hostname) ||
      ownerAddress.port !== runtimeAddress.port ||
      ownerAddress.pathname !== runtimeAddress.pathname ||
      !disposableDatabase
    ) {
      throw new Error(
        "Integration config deletion runtime test requires the same named loopback database"
      )
    }

    const [role] = await runtime.$queryRaw<Array<{ superuser: boolean; bypass: boolean }>>`
      SELECT rolsuper AS superuser, rolbypassrls AS bypass
      FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ superuser: false, bypass: false })

    const [functionAccess] = await runtime.$queryRaw<Array<{ available: boolean }>>`
      SELECT to_regprocedure(
        'app.enqueue_integration_config_deletion_task(text,text,text)'
      ) IS NOT NULL
      AND has_function_privilege(
        current_user,
        'app.enqueue_integration_config_deletion_task(text,text,text)',
        'EXECUTE'
      ) AS available`
    expect(functionAccess?.available).toBe(true)

    await owner.workspace.createMany({
      data: [
        { id: workspaceId, name: "Integration outbox owner", slug: workspaceId },
        { id: otherWorkspaceId, name: "Integration outbox other", slug: otherWorkspaceId },
      ],
    })
    await owner.integration.create({
      data: {
        workspaceId,
        type: "SLACK",
        name: "Runtime integration credential",
        configRef: storageUri,
        status: "disabled",
      },
    })
  })

  afterAll(async () => {
    try {
      if (owner) {
        await owner.artifactDeletionTask.deleteMany({
          where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
        })
        await owner.$executeRaw`DELETE FROM "Workspace" WHERE id IN (${workspaceId}, ${otherWorkspaceId})`
      }
    } finally {
      await owner?.$disconnect()
      await runtime?.$disconnect()
    }
  })

  it("enqueues only the referenced URI under its bound workspace for the restricted runtime role", async () => {
    if (!runtime || !owner) throw new Error("Disposable role fixtures were not created")
    const taskId = createId()
    const enqueue = (contextWorkspace: string, workspace: string, uri: string, id = createId()) =>
      runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${contextWorkspace}, true)`
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT app.enqueue_integration_config_deletion_task(${id}, ${workspace}, ${uri}) AS id`
        return rows[0]?.id
      })

    expect(await enqueue(workspaceId, workspaceId, storageUri, taskId)).toBe(taskId)
    expect(await enqueue(workspaceId, workspaceId, storageUri)).toBe(taskId)
    expect(
      await owner.artifactDeletionTask.count({
        where: { kind: "INTEGRATION_CONFIG", storageUri },
      })
    ).toBe(1)

    await expect(
      enqueue(
        workspaceId,
        workspaceId,
        `s3://evidence-test/evidence/${workspaceId}/integrations/unknown.enc`
      )
    ).rejects.toThrow(/not an integration config/i)
    await expect(enqueue(otherWorkspaceId, workspaceId, storageUri)).rejects.toThrow(
      /workspace context mismatch/i
    )
    await expect(
      runtime.$queryRaw`
        SELECT app.enqueue_integration_config_deletion_task(
          ${createId()}, ${workspaceId}, ${storageUri}
        ) AS id`
    ).rejects.toThrow(/workspace context mismatch/i)
  })
})
