import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createId } from "@paralleldrive/cuid2"
import { PrismaPg } from "@prisma/adapter-pg"
import { prisma } from "./client"
import { PrismaClient } from "./generated/prisma"
import {
  claimArtifactDeletionTask,
  completeArtifactDeletionTask,
  failArtifactDeletionTask,
} from "./artifact-deletion"

const ids: string[] = []
const roleSuffix = createId().slice(0, 12)
const systemRole = `app_system_test_${roleSuffix}`
const systemPassword = `artifact-${roleSuffix}`
let restrictedSystem: PrismaClient | undefined
let schemaAvailable = false

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) return
  const functions = await prisma.$queryRaw<Array<{ available: boolean }>>`
    SELECT to_regprocedure(
      'app.claim_artifact_deletion_task(text[],timestamp,text,timestamp)'
    ) IS NOT NULL AS available`
  if (functions[0]?.available !== true) return
  schemaAvailable = true
  const parsedDatabaseUrl = new URL(databaseUrl)
  const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1))
  if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error("Artifact deletion role test requires a simple PostgreSQL database name")
  }

  await prisma.$executeRawUnsafe(
    `CREATE ROLE ${systemRole} LOGIN PASSWORD '${systemPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`
  )
  await prisma.$executeRawUnsafe(`GRANT CONNECT ON DATABASE ${databaseName} TO ${systemRole}`)
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA app TO ${systemRole}`)
  await prisma.$executeRawUnsafe(
    `GRANT EXECUTE ON FUNCTION app.claim_artifact_deletion_task(text[], timestamp, text, timestamp), app.complete_artifact_deletion_task(text, text), app.fail_artifact_deletion_task(text, text, text, timestamp, text), app.count_dead_letter_artifact_deletion_tasks() TO ${systemRole}`
  )

  const restrictedUrl = parsedDatabaseUrl
  restrictedUrl.username = systemRole
  restrictedUrl.password = systemPassword
  restrictedSystem = new PrismaClient({
    adapter: new PrismaPg({ connectionString: restrictedUrl.toString() }),
  })
})

afterAll(async () => {
  await restrictedSystem?.$disconnect()
  if (schemaAvailable) {
    await prisma.$executeRawUnsafe(`DROP OWNED BY ${systemRole}`)
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${systemRole}`)
  }
})

afterEach(async () => {
  if (!schemaAvailable) return
  await prisma.artifactDeletionTask.deleteMany({ where: { id: { in: ids.splice(0) } } })
})

function newTask() {
  const id = createId()
  ids.push(id)
  return prisma.artifactDeletionTask.create({
    data: {
      id,
      workspaceId: `workspace-${id}`,
      kind: "EVIDENCE",
      storageUri: `s3://evidence/evidence/workspace-${id}/receipt.enc`,
    },
  })
}

describe("artifact deletion task leases", () => {
  it("lets a non-owner system role use only the reviewed worker RPCs", async () => {
    if (!schemaAvailable || !restrictedSystem) return
    const created = await newTask()
    const now = new Date("2026-08-27T00:00:00.000Z")
    const leaseToken = `lease-${createId()}`

    await expect(
      restrictedSystem.$queryRaw`SELECT * FROM "ArtifactDeletionTask" WHERE id = ${created.id}`
    ).rejects.toThrow()

    const claimed = await restrictedSystem.$queryRaw<Array<{ id: string; leaseToken: string }>>`
      SELECT id, "leaseToken" FROM app.claim_artifact_deletion_task(
        ${[created.id]}::text[], ${now}, ${leaseToken}, ${new Date(now.getTime() + 60_000)}
      )`
    expect(claimed).toEqual([{ id: created.id, leaseToken }])

    const counts = await restrictedSystem.$queryRaw<Array<{ count: bigint }>>`
      SELECT app.count_dead_letter_artifact_deletion_tasks() AS count`
    expect(Number(counts[0]?.count)).toBeGreaterThanOrEqual(0)

    const completed = await restrictedSystem.$queryRaw<Array<{ completed: boolean }>>`
      SELECT app.complete_artifact_deletion_task(${created.id}, ${leaseToken}) AS completed`
    expect(completed).toEqual([{ completed: true }])
  })

  it("claims once, retries after failure, then completes idempotently", async () => {
    if (!schemaAvailable) return
    const created = await newTask()
    const now = new Date("2026-08-27T00:00:00.000Z")

    const first = await claimArtifactDeletionTask([created.id], now)
    expect(first).toMatchObject({ id: created.id, status: "PROCESSING", attempts: 1 })
    expect(await claimArtifactDeletionTask([created.id], now)).toBeNull()

    expect(await failArtifactDeletionTask(first!, new Error("temporary failure"), now)).toBe(
      "retry"
    )
    expect(await claimArtifactDeletionTask([created.id], now)).toBeNull()

    const second = await claimArtifactDeletionTask(
      [created.id],
      new Date(now.getTime() + 2 * 60_000)
    )
    expect(second).toMatchObject({ id: created.id, status: "PROCESSING", attempts: 2 })
    expect(await completeArtifactDeletionTask(second!.id, second!.leaseToken!)).toBe(true)
    expect(await completeArtifactDeletionTask(second!.id, second!.leaseToken!)).toBe(false)
  })

  it("rejects corrupt task kind, status, attempts, and lease states", async () => {
    if (!schemaAvailable) return
    const base = {
      id: createId(),
      workspaceId: "workspace-constraints",
      kind: "EVIDENCE",
      storageUri: `s3://evidence/evidence/workspace-constraints/${createId()}.enc`,
    }

    for (const data of [
      { ...base, id: createId(), kind: "REPORT" },
      { ...base, id: createId(), status: "UNKNOWN" },
      { ...base, id: createId(), attempts: -1 },
      { ...base, id: createId(), status: "PROCESSING" },
      { ...base, id: createId(), leaseToken: "unexpected" },
    ]) {
      await expect(prisma.artifactDeletionTask.create({ data })).rejects.toThrow()
    }
  })
})
