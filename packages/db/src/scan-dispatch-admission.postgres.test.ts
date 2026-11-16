import { createHash, randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "./generated/prisma"
import { createBoundedPgAdapter } from "./pool"
import { createScan } from "./scan-service"
import { hashDelegatedAdmissionProof } from "./agent-operation-hash"
import { createScanDispatchAuthorityBroker } from "./scan-dispatch-authority-broker"
import type { CreateScanParams } from "./scan-service-types"

// Hoisting runs this guard before imports can construct a client from ambient
// env. Bind the fixture's privileged DATABASE_URL role to its restricted
// dispatch authority runtime role through the shared disposable-pair guard.
await vi.hoisted(async () => {
  const runtime = process.env.DISPATCH_AUTHORITY_RUNTIME_DATABASE_URL
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1" || !runtime) return
  const { assertDisposableDatabasePair } =
    await import("../../../.github/scripts/vitest-database-env.mjs")
  assertDisposableDatabasePair({ ...process.env, RLS_RUNTIME_DATABASE_URL: runtime })
})

const enabled =
  process.env.SCAN_DISPATCH_AUTHORITY_POSTGRES_TEST === "1" &&
  process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1"
let owner: PrismaClient
let runtime: pg.Pool

async function admissionFixture() {
  const userId = randomUUID()
  const sponsorId = randomUUID()
  const workspaceId = randomUUID()
  const targetId = randomUUID()
  await owner.user.createMany({
    data: [userId, sponsorId].map((id) => ({
      id,
      name: "Fixture user",
      email: `${id}@example.test`,
    })),
  })
  await owner.workspace.create({
    data: {
      id: workspaceId,
      name: "Shadow admission",
      slug: workspaceId,
      agencySponsorAccountId: sponsorId,
    },
  })
  await owner.target.create({ data: { id: targetId, workspaceId, type: "REPO", name: "fixture" } })
  const params: CreateScanParams = {
    workspaceId,
    targetId,
    createdById: userId,
    goal: "TEST_APP",
    mode: "SAFE",
  }
  return { params, sponsorId }
}

async function admit(params: CreateScanParams) {
  return owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${params.workspaceId}, true)`
    return createScan(params, tx as never, { dispatchAuthority: "shadow" })
  })
}

describe.skipIf(!enabled)("shadow admission with disposable PostgreSQL", () => {
  beforeAll(async () => {
    const ownerUrl = new URL(process.env.DATABASE_URL ?? "")
    const runtimeUrl = new URL(process.env.DISPATCH_AUTHORITY_RUNTIME_DATABASE_URL ?? "")
    if (
      ownerUrl.hostname !== "127.0.0.1" ||
      ownerUrl.username !== "postgres" ||
      ownerUrl.pathname !== "/lyrashield_test" ||
      runtimeUrl.host !== ownerUrl.host ||
      runtimeUrl.pathname !== ownerUrl.pathname ||
      runtimeUrl.username !== "dispatch_authority_runtime"
    )
      throw new Error("expected the owned local disposable authority fixture")
    owner = new PrismaClient({
      adapter: createBoundedPgAdapter(ownerUrl.href, "db:test:shadow-admission"),
    })
    runtime = new pg.Pool({ connectionString: runtimeUrl.href })
  })

  afterAll(async () => {
    if (runtime) await runtime.end()
    if (owner) await owner.$disconnect()
  })

  it("commits plan, reservation, event and quarantined identities together using the SQL digest", async () => {
    const { params, sponsorId } = await admissionFixture()
    const scan = await admit(params)
    const operation = await owner.scanDispatchOperation.findUniqueOrThrow({
      where: { scanId: scan.id },
    })
    const outbox = await owner.scanQueueOutbox.findUniqueOrThrow({ where: { scanId: scan.id } })
    const [digest] = await owner.$queryRaw<Array<{ digest: string }>>`
      SELECT app.scan_dispatch_scope_digest(${scan.id}) AS digest
    `
    expect(operation).toMatchObject({
      workspaceId: params.workspaceId,
      state: "UNKNOWN",
      requestDigest: digest!.digest,
    })
    expect(outbox).toMatchObject({
      operationId: operation.operationId,
      jobId: scan.id,
      state: "UNKNOWN",
    })
    expect(scan.executionPlanHash).toMatch(/^[a-f0-9]{64}$/)
    expect(
      await owner.scanCapacityReservation.findUnique({ where: { scanId: scan.id } })
    ).toMatchObject({ accountId: sponsorId })
    expect(await owner.scanEvent.count({ where: { scanId: scan.id, stage: "queued" } })).toBe(1)
    expect(
      await owner.userScanSlot.findUnique({ where: { userId: params.createdById } })
    ).toMatchObject({ scanId: scan.id })
  })

  it("rolls back the entire admission if an outbox write fails after the other writes", async () => {
    const { params } = await admissionFixture()
    await expect(
      owner.$transaction(async (tx) => {
        const wrapped = Object.create(tx)
        wrapped.scanQueueOutbox = {
          create: () => Promise.reject(new Error("injected outbox failure")),
        }
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${params.workspaceId}, true)`
        await createScan(params, wrapped, { dispatchAuthority: "shadow" })
      })
    ).rejects.toThrow("injected outbox failure")
    expect(await owner.scan.count({ where: { workspaceId: params.workspaceId } })).toBe(0)
    expect(
      await owner.scanDispatchOperation.count({ where: { workspaceId: params.workspaceId } })
    ).toBe(0)
    expect(
      await owner.scanCapacityReservation.count({ where: { workspaceId: params.workspaceId } })
    ).toBe(0)
    expect(
      await owner.userScanSlot.findUnique({ where: { userId: params.createdById } })
    ).toBeNull()
    expect(
      await owner.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM "ScanEvent" e JOIN "Scan" s ON s.id = e."scanId"
      WHERE s."workspaceId" = ${params.workspaceId}
    `
    ).toEqual([{ count: 0n }])
  })

  it("serializes concurrent admission without creating another dispatch operation or outbox", async () => {
    const { params } = await admissionFixture()
    const attempts = await Promise.allSettled([admit(params), admit(params)])
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1)
    const scan = await owner.scan.findFirstOrThrow({ where: { workspaceId: params.workspaceId } })
    expect(await owner.scan.count({ where: { workspaceId: params.workspaceId } })).toBe(1)
    expect(await owner.scanDispatchOperation.count({ where: { scanId: scan.id } })).toBe(1)
    expect(await owner.scanQueueOutbox.count({ where: { scanId: scan.id } })).toBe(1)
  })

  it("keeps the delegated operation and its provenance separate from dispatch authority", async () => {
    const { params } = await admissionFixture()
    const connection = await owner.agentConnection.create({
      data: {
        workspaceId: params.workspaceId,
        userId: params.createdById,
        clientType: "test",
        allowedTargetIds: [params.targetId],
        allowedOperations: ["scan.create"],
        allowedProfiles: ["REPO_SAFE"],
      },
    })
    const delegated = await owner.agentOperation.create({
      data: {
        workspaceId: params.workspaceId,
        connectionId: connection.id,
        principalId: connection.id,
        operationName: "scan.create",
        idempotencyKey: randomUUID(),
        inputHash: "fixture-input",
        admissionProofHash: hashDelegatedAdmissionProof("fixture-proof"),
        status: "EXECUTING",
      },
    })
    const scan = await admit({
      ...params,
      delegatedConnection: { connectionId: connection.id, authorizationVersion: 1 },
      delegatedOperation: {
        operationId: delegated.id,
        connectionId: connection.id,
        authorizationVersion: 1,
        admissionProof: "fixture-proof",
      },
    })
    const dispatch = await owner.scanDispatchOperation.findUniqueOrThrow({
      where: { scanId: scan.id },
    })
    expect(dispatch.operationId).not.toBe(delegated.id)
    expect(
      await owner.delegatedScanProvenance.findUnique({ where: { operationId: delegated.id } })
    ).toMatchObject({
      scanId: scan.id,
      scanExecutionPlanHash: scan.executionPlanHash,
    })
    expect(await owner.agentOperation.findUnique({ where: { id: delegated.id } })).toMatchObject({
      resultReference: scan.id,
    })
    expect(await owner.scanQueueOutbox.findUnique({ where: { scanId: scan.id } })).toMatchObject({
      operationId: dispatch.operationId,
    })
  })

  it("cannot prepare or lease shadow rows even with a valid grant in an open epoch", async () => {
    const { params } = await admissionFixture()
    const scan = await admit(params)
    const operation = await owner.scanDispatchOperation.findUniqueOrThrow({
      where: { scanId: scan.id },
    })
    // The owned runner creates this common epoch before launching either suite.
    // Do not depend on broker-test setup or accept an arbitrary open epoch.
    const epoch = await owner.scanAuthorityEpoch.findUniqueOrThrow({
      where: { id: "authority-shared-open-epoch" },
    })
    expect(epoch).toMatchObject({
      isOpen: true,
      openKey: "open",
      openedAt: expect.any(Date),
      closedAt: null,
    })
    const instanceId = randomUUID()
    const grant = await owner.scanWorkerInstanceGrant.create({
      data: {
        authorityEpochId: epoch.id,
        instanceId,
        credentialHash: createHash("sha256").update(instanceId).digest("hex"),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    const broker = createScanDispatchAuthorityBroker({
      connectionString: process.env.DATABASE_URL!,
    })
    try {
      await expect(
        broker.prepare({
          operationId: operation.operationId,
          authorityEpochId: epoch.id,
          workerInstanceId: instanceId,
          workerGrantId: grant.id,
          expiresAt: new Date(Date.now() + 60_000),
        })
      ).rejects.toMatchObject({ code: "PREPARATION_AUTHORITY_CLOSED" })
    } finally {
      await broker.close()
    }
    await expect(
      owner.scanQueueOutbox.update({ where: { scanId: scan.id }, data: { state: "LEASED" } })
    ).rejects.toThrow()
    await expect(
      owner.scanDispatchOperation.update({
        where: { operationId: operation.operationId },
        data: { state: "QUEUED" },
      })
    ).rejects.toThrow()
    expect(await owner.scanDispatchAttempt.count({ where: { scanId: scan.id } })).toBe(0)
  })

  it("keeps authority-table privileges denied to the existing runtime role", async () => {
    const { params } = await admissionFixture()
    const scan = await admit(params)
    for (const table of ["ScanDispatchOperation", "ScanQueueOutbox"]) {
      const privileges = await runtime.query<{ allowed: boolean }>(
        "SELECT has_table_privilege(current_user, $1, 'SELECT,INSERT,UPDATE,DELETE') AS allowed",
        [`"${table}"`]
      )
      expect(privileges.rows[0]!.allowed).toBe(false)
    }
    await expect(
      runtime.query('SELECT * FROM "ScanQueueOutbox" WHERE "scanId"=$1', [scan.id])
    ).rejects.toMatchObject({ code: "42501" })
  })
})
