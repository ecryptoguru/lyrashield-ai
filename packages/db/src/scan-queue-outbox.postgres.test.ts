import { createHash, randomBytes, randomUUID } from "node:crypto"
import pg from "pg"
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "./generated/prisma"
import { createBoundedPgAdapter } from "./pool"
import { createScan } from "./scan-service"
import { buildScanQueuePayload, scanQueueDigest } from "./scan-queue-payload"
import {
  createScanQueueOutboxDispatcher,
  type ScanQueueOutboxTransport,
} from "./scan-queue-outbox-dispatcher"
import { createScanQueueOutboxStore } from "./scan-queue-outbox-store"
import { createScanDispatchAuthorityBroker } from "./scan-dispatch-authority-broker"
import { fixtureQueueTransport, queueFixtureWorker } from "../scripts/tests/queue-outbox-fixture"
import {
  applyPreparationFixtureMigration,
  installPreparationFixtureRole,
  fixturePreparationCompiler,
} from "../scripts/tests/scan-preparation-fixture"
import { getScanQueue } from "../../integrations/src/queue"
import type { ScanFocus } from "@lyrashield/types"
import { withScanDispatchWorkerCredential } from "./scan-dispatch-worker-assignment"
import { createScanQueuePublicationVerifier } from "./scan-queue-publication-verifier"

// Hoisting runs this guard before imports can construct a client from ambient
// env. Bind the fixture's privileged DATABASE_URL role to its restricted
// queue-outbox publisher role through the shared disposable-pair guard.
await vi.hoisted(async () => {
  const runtime = process.env.QUEUE_OUTBOX_DATABASE_URL
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
let maintenance: pg.Pool
let fixtureDatabase: string | undefined
let workerGrant: { id: string; authorityEpochId: string; instanceId: string }
let workerBrokerUrl: string
const workerCredential = randomBytes(32).toString("hex")
const queueWorker = queueFixtureWorker()

async function fixture(focus?: ScanFocus, shadow = false, legacy = false) {
  const userId = randomUUID()
  const workspaceId = randomUUID()
  const targetId = randomUUID()
  await owner.user.create({
    data: { id: userId, name: "Queue fixture", email: `${userId}@example.test` },
  })
  await owner.workspace.create({
    data: { id: workspaceId, name: "Queue fixture", slug: workspaceId },
  })
  await owner.target.create({ data: { id: targetId, workspaceId, type: "REPO", name: "fixture" } })
  const scan = await owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id',${workspaceId},true)`
    return createScan(
      {
        workspaceId,
        targetId,
        createdById: userId,
        goal: "TEST_APP",
        mode: "SAFE",
        focus,
        source: { revision: "a".repeat(40) },
      },
      tx as never,
      shadow ? { dispatchAuthority: "shadow" } : undefined
    )
  })
  if (shadow)
    return {
      scan,
      scope: {
        workspaceId,
        operationId: (
          await owner.scanDispatchOperation.findUniqueOrThrow({ where: { scanId: scan.id } })
        ).operationId,
      },
    }
  const [{ digest }] = await owner.$queryRaw<
    Array<{ digest: string }>
  >`SELECT app.scan_dispatch_scope_digest(${scan.id}) AS digest`
  const operation = await owner.scanDispatchOperation.create({
    data: { scanId: scan.id, workspaceId, requestDigest: digest },
  })
  const payloadInputJson = buildScanQueuePayload(scan, focus)
  await owner.scanQueueOutbox.create({
    data: {
      scanId: scan.id,
      operationId: operation.operationId,
      jobId: scan.id,
      payloadDigest: scanQueueDigest(payloadInputJson),
      payloadInputJson: legacy ? null : payloadInputJson,
    },
  })
  return { scan, scope: { workspaceId, operationId: operation.operationId } }
}

function dispatcher(transport: ScanQueueOutboxTransport = fixtureQueueTransport, leaseMs = 30_000) {
  return createScanQueueOutboxDispatcher({
    pool: runtime,
    transport,
    mode: "qualification",
    leaseMs,
    transportTimeoutMs: 3000,
  })
}

describe.skipIf(!enabled)("closed outbox dispatcher with restricted PostgreSQL and Redis", () => {
  beforeAll(async () => {
    const ownerUrl = new URL(process.env.DATABASE_URL ?? "")
    const runtimeUrl = new URL(process.env.QUEUE_OUTBOX_DATABASE_URL ?? "")
    const redisUrl = new URL(process.env.REDIS_URL ?? "")
    if (
      ownerUrl.hostname !== "127.0.0.1" ||
      ownerUrl.username !== "postgres" ||
      ownerUrl.pathname !== "/lyrashield_test" ||
      runtimeUrl.host !== ownerUrl.host ||
      runtimeUrl.pathname !== ownerUrl.pathname ||
      runtimeUrl.username !== "dispatch_queue_publisher" ||
      redisUrl.hostname !== "127.0.0.1" ||
      redisUrl.username !== "outbox-publisher"
    )
      throw new Error("requires the owned disposable PostgreSQL/Redis fixture")
    await queueWorker.open()
    const sqlOwner = new pg.Pool({ connectionString: ownerUrl.href })
    try {
      await applyPreparationFixtureMigration(sqlOwner)
      await installPreparationFixtureRole(sqlOwner)
    } finally {
      await sqlOwner.end()
    }
    const maintenanceUrl = new URL(ownerUrl.href)
    maintenanceUrl.pathname = "/postgres"
    maintenance = new pg.Pool({ connectionString: maintenanceUrl.href, max: 1 })
    const createdDatabase = `lyrashield_queue_assignment_test_${randomBytes(6).toString("hex")}`
    // Names are generated here after the disposable-pair guard; no caller SQL input.
    await maintenance.query(`CREATE DATABASE "${createdDatabase}" TEMPLATE lyrashield_test`)
    fixtureDatabase = createdDatabase
    await maintenance.query(`REVOKE TEMPORARY ON DATABASE "${fixtureDatabase}" FROM PUBLIC`)
    ownerUrl.pathname = `/${fixtureDatabase}`
    runtimeUrl.pathname = ownerUrl.pathname
    const brokerUrl = new URL(process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!)
    brokerUrl.pathname = ownerUrl.pathname
    workerBrokerUrl = brokerUrl.href
    owner = new PrismaClient({
      adapter: createBoundedPgAdapter(ownerUrl.href, "db:test:queue-outbox"),
    })
    runtime = new pg.Pool({
      connectionString: runtimeUrl.href,
      max: 4,
      connectionTimeoutMillis: 3000,
      query_timeout: 5000,
    })
    runtime.on("error", () => undefined)
    runtime.on("connect", (client) => client.on("error", () => undefined))
    // Historical source fixtures use many grants. Their copied epochs close
    // only inside this owned clone; the launch publisher receives one new grant.
    await owner.scanAuthorityEpoch.updateMany({
      where: { isOpen: true },
      data: { isOpen: false, openKey: null, closedAt: new Date() },
    })
    const highest = await owner.scanAuthorityEpoch.aggregate({ _max: { epoch: true } })
    const epoch = await owner.scanAuthorityEpoch.create({
      data: {
        epoch: (highest._max.epoch ?? 0) + 1,
        isOpen: true,
        openKey: "open",
        openedAt: new Date(),
      },
    })
    workerGrant = await owner.scanWorkerInstanceGrant.create({
      data: {
        authorityEpochId: epoch.id,
        instanceId: randomUUID(),
        credentialHash: createHash("sha256").update(workerCredential).digest("hex"),
        expiresAt: new Date(Date.now() + 3600000),
      },
    })
  }, 60000)
  afterAll(async () => {
    await queueWorker.close()
    await runtime?.end()
    await owner?.$disconnect()
    if (fixtureDatabase) await maintenance.query(`DROP DATABASE "${fixtureDatabase}"`)
    await maintenance?.end()
  })

  it("publishes exact admitted focus once and retains an immutable positive receipt", async () => {
    const { scan, scope } = await fixture("payments")
    const publish = vi.fn(fixtureQueueTransport.publish)
    const service = dispatcher({ ...fixtureQueueTransport, publish })
    expect(await service.dispatch(scope)).toMatchObject({ kind: "published" })
    expect((await service.dispatch(scope)).kind).toBe("published")
    expect(publish).toHaveBeenCalledTimes(1)
    const row = await owner.scanQueueOutbox.findUniqueOrThrow({ where: { scanId: scan.id } })
    expect(row).toMatchObject({ state: "PUBLISHED", attempts: 1 })
    expect(
      await owner.scanDispatchWorkerAssignment.findUniqueOrThrow({
        where: { operationId: scope.operationId },
      })
    ).toMatchObject({
      workspaceId: scope.workspaceId,
      workerGrantId: workerGrant.id,
      authorityEpochId: workerGrant.authorityEpochId,
    })
    expect(JSON.parse(row.payloadInputJson!).focus).toBe("payments")
    expect(row.publicationReceiptChecksum).toBe(scanQueueDigest(row.publicationReceiptInputJson!))
    expect(
      (await service.verifyDispatch(scope, (await fixtureQueueTransport.read(scan.id))!)).kind
    ).toBe("published")
    const reader = createScanQueuePublicationVerifier(workerBrokerUrl)
    const snapshot = (await fixtureQueueTransport.read(scan.id))!
    const verify = (credential: string, input = { ...scope, snapshot }) =>
      withScanDispatchWorkerCredential(credential, { operationId: scope.operationId }, () =>
        reader.verifyDispatch(input)
      )
    try {
      expect(await verify(workerCredential)).toEqual({
        kind: "published",
        row: {
          operationId: scope.operationId,
          id: scan.id,
          workspaceId: scope.workspaceId,
          executionPlanHash: scan.executionPlanHash,
          requestDigest: (
            await owner.scanDispatchOperation.findUniqueOrThrow({
              where: { operationId: scope.operationId },
            })
          ).requestDigest,
          payloadInputJson: row.payloadInputJson,
        },
      })
      await expect(verify(randomBytes(32).toString("hex"))).rejects.toMatchObject({
        code: "WORKER_GRANT_INVALID",
      })
      await expect(
        verify(workerCredential, { ...scope, workspaceId: "foreign-workspace", snapshot })
      ).rejects.toMatchObject({ code: "WORKER_GRANT_INVALID" })
      expect(
        await verify(workerCredential, { ...scope, snapshot: { ...snapshot, id: "foreign-scan" } })
      ).toEqual({ kind: "closed" })
      expect(await owner.scanQueueOutbox.findUniqueOrThrow({ where: { scanId: scan.id } })).toEqual(
        row
      )
    } finally {
      await reader.close()
    }
    await expect(
      owner.scanQueueOutbox.update({
        where: { scanId: scan.id },
        data: { payloadInputJson: row.payloadInputJson + " " },
      })
    ).rejects.toThrow()
    await expect(
      owner.scanQueueOutbox.update({
        where: { scanId: scan.id },
        data: { publicationReceiptInputJson: row.publicationReceiptInputJson + " " },
      })
    ).rejects.toThrow()
  })
  it("binds pre-attempt status to the assigned credential and never leaks another operation", async () => {
    const { scope } = await fixture()
    expect((await dispatcher().dispatch(scope)).kind).toBe("published")
    const broker = createScanDispatchAuthorityBroker({ connectionString: workerBrokerUrl })
    try {
      expect(
        await withScanDispatchWorkerCredential(
          workerCredential,
          { operationId: scope.operationId },
          () => broker.status(scope.operationId)
        )
      ).toMatchObject({ kind: "available", operationId: scope.operationId, attemptId: null })
      await expect(
        withScanDispatchWorkerCredential(
          randomBytes(32).toString("hex"),
          { operationId: scope.operationId },
          () => broker.status(scope.operationId)
        )
      ).rejects.toMatchObject({ code: "WORKER_GRANT_INVALID" })
      const other = await fixture()
      await expect(
        withScanDispatchWorkerCredential(workerCredential, { operationId: scope.operationId }, () =>
          broker.status(other.scope.operationId)
        )
      ).rejects.toMatchObject({ code: "WORKER_GRANT_INVALID" })
      await expect(
        owner.scanDispatchWorkerAssignment.update({
          where: { operationId: scope.operationId },
          data: { workerGrantId: "another-grant" },
        })
      ).rejects.toThrow()
    } finally {
      await broker.close()
    }
  })
  it("serializes concurrent publishers and never increments another lease for a duplicate", async () => {
    const { scan, scope } = await fixture()
    const publish = vi.fn(fixtureQueueTransport.publish)
    const services = [
      dispatcher({ ...fixtureQueueTransport, publish }),
      dispatcher({ ...fixtureQueueTransport, publish }),
    ]
    const results = await Promise.all(services.map((service) => service.dispatch(scope)))
    expect(results.some((result) => result.kind === "published")).toBe(true)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(
      (await owner.scanQueueOutbox.findUniqueOrThrow({ where: { scanId: scan.id } })).attempts
    ).toBe(1)
  })
  it("refuses ambiguous live worker grants before publishing or assigning", async () => {
    const { scan, scope } = await fixture()
    const extra = await owner.scanWorkerInstanceGrant.create({
      data: {
        authorityEpochId: workerGrant.authorityEpochId,
        instanceId: randomUUID(),
        credentialHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
        expiresAt: new Date(Date.now() + 3600000),
      },
    })
    const publish = vi.fn(fixtureQueueTransport.publish)
    try {
      expect((await dispatcher({ ...fixtureQueueTransport, publish }).dispatch(scope)).kind).toBe(
        "unknown"
      )
      expect(publish).not.toHaveBeenCalled()
      expect(
        await owner.scanDispatchWorkerAssignment.count({
          where: { operationId: scope.operationId },
        })
      ).toBe(0)
      expect(
        await owner.scanQueueOutbox.findUniqueOrThrow({ where: { scanId: scan.id } })
      ).toMatchObject({ state: "PENDING", attempts: 0 })
    } finally {
      await owner.$executeRaw`UPDATE "ScanWorkerInstanceGrant" SET "revokedAt"=clock_timestamp(), "updatedAt"=clock_timestamp() WHERE id=${extra.id}`
    }
  })

  it("keeps credential hashes and native worker verification private from the publisher", async () => {
    await expect(
      runtime.query('SELECT "credentialHash" FROM "ScanWorkerInstanceGrant"')
    ).rejects.toMatchObject({ code: "42501" })
    await expect(
      runtime.query("SELECT * FROM app.require_scan_dispatch_worker($1,$2)", [
        "operation-unknown",
        createHash("sha256").update(workerCredential).digest("hex"),
      ])
    ).rejects.toMatchObject({ code: "42501" })
    await expect(
      runtime.query('SELECT * FROM "ScanDispatchWorkerAssignment"')
    ).rejects.toMatchObject({ code: "42501" })
  })
  it("keeps shadow and legacy-null rows unavailable without enqueue or backfill", async () => {
    const publish = vi.fn(fixtureQueueTransport.publish)
    const service = dispatcher({ ...fixtureQueueTransport, publish })
    const shadow = await fixture(undefined, true)
    expect((await service.dispatch(shadow.scope)).kind).toBe("closed")
    const legacy = await fixture(undefined, false, true)
    expect((await service.dispatch(legacy.scope)).kind).toBe("unknown")
    const row = await owner.scanQueueOutbox.findUniqueOrThrow({ where: { scanId: legacy.scan.id } })
    expect(row).toMatchObject({ state: "UNKNOWN", payloadInputJson: null, attempts: 0 })
    await expect(
      owner.scanQueueOutbox.update({
        where: { scanId: legacy.scan.id },
        data: { payloadInputJson: buildScanQueuePayload(legacy.scan) },
      })
    ).rejects.toThrow()
    expect(publish).not.toHaveBeenCalled()
  })
  it("rejects a same-ID foreign payload already in the real queue", async () => {
    const { scan, scope } = await fixture("auth")
    await fixtureQueueTransport.publish({
      ...JSON.parse(buildScanQueuePayload(scan, "auth")),
      workspaceId: "foreign-workspace",
    })
    expect((await dispatcher().dispatch(scope)).kind).toBe("unknown")
    const row = await owner.scanQueueOutbox.findUniqueOrThrow({ where: { scanId: scan.id } })
    expect(row).toMatchObject({ state: "UNKNOWN", publishedAt: null })
    expect((await fixtureQueueTransport.read(scan.id))!.data).toMatchObject({
      workspaceId: "foreign-workspace",
    })
  })
  it("recovers lost enqueue acknowledgement only through exact positive readback", async () => {
    const { scan, scope } = await fixture()
    const publish = vi.fn(async (payload) => {
      await fixtureQueueTransport.publish(payload)
      throw new Error("injected lost enqueue ACK")
    })
    expect((await dispatcher({ ...fixtureQueueTransport, publish }).dispatch(scope)).kind).toBe(
      "published"
    )
    expect(publish).toHaveBeenCalledTimes(1)
    expect(
      (await owner.scanQueueOutbox.findUniqueOrThrow({ where: { scanId: scan.id } })).state
    ).toBe("PUBLISHED")
  })
  it("keeps negative readbacks UNKNOWN and later confirms the same job without re-enqueue", async () => {
    const { scan, scope } = await fixture()
    const publish = vi.fn(fixtureQueueTransport.publish)
    const negative = dispatcher({ publish, read: async () => null })
    expect((await negative.dispatch(scope)).kind).toBe("unknown")
    expect((await negative.dispatch(scope)).kind).toBe("unknown")
    expect(publish).toHaveBeenCalledTimes(1)
    expect((await dispatcher({ ...fixtureQueueTransport, publish }).dispatch(scope)).kind).toBe(
      "published"
    )
    expect(publish).toHaveBeenCalledTimes(1)
    expect(
      (await owner.scanQueueOutbox.findUniqueOrThrow({ where: { scanId: scan.id } })).attempts
    ).toBe(1)
  })
  it("quarantines an expired abandoned lease without publishing or releasing capacity", async () => {
    const { scan, scope } = await fixture()
    expect((await createScanQueueOutboxStore(runtime, 1000).claim(scope)).kind).toBe("leased")
    await expect(
      owner.scanQueueOutbox.update({
        where: { scanId: scan.id },
        data: { state: "PENDING" },
      })
    ).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const publish = vi.fn(fixtureQueueTransport.publish)
    expect((await dispatcher({ ...fixtureQueueTransport, publish }).dispatch(scope)).kind).toBe(
      "unknown"
    )
    expect((await dispatcher({ publish, read: async () => null }).dispatch(scope)).kind).toBe(
      "unknown"
    )
    expect(publish).not.toHaveBeenCalled()
    expect(
      await owner.scanCapacityReservation.findUnique({ where: { scanId: scan.id } })
    ).toMatchObject({ state: "WAITING" })
  })
  it("quarantines changed target identity and denies cross-workspace lookup", async () => {
    const { scan, scope } = await fixture()
    const target = await owner.target.create({
      data: { workspaceId: scan.workspaceId, type: "REPO", name: "changed" },
    })
    await owner.scan.update({ where: { id: scan.id }, data: { targetId: target.id } })
    const publish = vi.fn(fixtureQueueTransport.publish)
    expect((await dispatcher({ ...fixtureQueueTransport, publish }).dispatch(scope)).kind).toBe(
      "unknown"
    )
    expect((await dispatcher().dispatch({ ...scope, workspaceId: "foreign" })).kind).toBe("missing")
    expect(publish).not.toHaveBeenCalled()
    expect(
      (await owner.scanQueueOutbox.findUniqueOrThrow({ where: { scanId: scan.id } })).state
    ).toBe("UNKNOWN")
  })
  it("rejects a fast consumer before publication confirmation and binds focus at broker preparation", async () => {
    const { scan, scope } = await fixture("payments")
    await owner.workspaceMember.create({
      data: {
        workspaceId: scan.workspaceId,
        userId: scan.createdById,
        role: "VIEWER",
        status: "active",
      },
    })
    await owner.billingAccount.create({
      data: { accountId: scan.createdById, status: "active", currentPlan: "PRO" },
    })
    const grant = workerGrant
    const broker = createScanDispatchAuthorityBroker({
      connectionString: workerBrokerUrl,
      preparationAuthority: "checked-intent-v1",
      compilePreparation: fixturePreparationCompiler,
    })
    const prepare = {
      operationId: scope.operationId,
      authorityEpochId: grant.authorityEpochId,
      workerInstanceId: grant.instanceId,
      workerGrantId: grant.id,
      expiresAt: new Date(Date.now() + 60000),
    }
    let service: ReturnType<typeof dispatcher>
    service = dispatcher({
      ...fixtureQueueTransport,
      publish: async (payload) => {
        const id = await fixtureQueueTransport.publish(payload)
        expect(
          (await service.verifyDispatch(scope, (await fixtureQueueTransport.read(id))!)).kind
        ).toBe("unknown")
        await expect(broker.prepare(prepare)).rejects.toMatchObject({
          code: "QUEUE_PUBLICATION_NOT_CONFIRMED",
        })
        expect(await owner.scanDispatchAttempt.count({ where: { scanId: scan.id } })).toBe(0)
        return id
      },
    })
    try {
      expect((await service.dispatch(scope)).kind).toBe("published")
      await owner.scanCapacityReservation.update({
        where: { scanId: scan.id },
        data: { state: "RESERVED", fundedMinutes: 2, poolMinutes: 2, runtimeLimitMs: 60000 },
      })
      expect(
        (
          await withScanDispatchWorkerCredential(
            workerCredential,
            {
              operationId: prepare.operationId,
              workerGrantId: prepare.workerGrantId,
              workerInstanceId: prepare.workerInstanceId,
              authorityEpochId: prepare.authorityEpochId,
            },
            () => broker.prepare(prepare)
          )
        ).kind
      ).toBe("committed")
      expect(
        await owner.scanDispatchAttempt.findUnique({ where: { operationId: scope.operationId } })
      ).toMatchObject({ focusDigest: scanQueueDigest(JSON.stringify("payments")) })
      expect(
        await owner.scanEvent.count({ where: { scanId: scan.id, stage: "billable_boundary" } })
      ).toBe(0)
    } finally {
      await broker.close()
    }
  })
  it.each(["LEASED", "PUBLISHED"])(
    "preserves %s after a lost COMMIT response without replaying enqueue",
    async (phase) => {
      const { scan, scope } = await fixture()
      const originalConnect = runtime.connect.bind(runtime)
      let drop = true
      const connectSpy = vi.spyOn(runtime, "connect").mockImplementation((async () => {
        const client = await originalConnect()
        const originalQuery = client.query.bind(client) as (
          ...args: unknown[]
        ) => Promise<pg.QueryResult>
        let mutation = false
        client.query = (async (...args: unknown[]) => {
          const sql = typeof args[0] === "string" ? args[0] : ""
          if (sql.includes(`SET state='${phase}'`)) mutation = true
          const result = await originalQuery(...args)
          if (sql === "COMMIT" && mutation && drop) {
            drop = false
            throw new Error("injected COMMIT ACK loss after commit")
          }
          return result
        }) as typeof client.query
        return client
      }) as typeof runtime.connect)
      const publish = vi.fn(fixtureQueueTransport.publish)
      const read = vi.fn(fixtureQueueTransport.read)
      try {
        expect(await dispatcher({ publish, read }).dispatch(scope)).toMatchObject({
          kind: "unknown",
          reasonCode: "QUEUE_DB_COMMIT_UNKNOWN",
        })
        expect(
          (await owner.scanQueueOutbox.findUniqueOrThrow({ where: { scanId: scan.id } })).state
        ).toBe(phase)
        if (phase === "PUBLISHED") {
          expect((await dispatcher({ publish, read }).dispatch(scope)).kind).toBe("published")
          expect(publish).toHaveBeenCalledTimes(1)
        } else {
          expect((await dispatcher({ publish, read }).dispatch(scope)).kind).toBe("busy")
          expect(publish).not.toHaveBeenCalled()
          expect(read).not.toHaveBeenCalled()
        }
      } finally {
        connectSpy.mockRestore()
      }
    }
  )
  it("keeps dispatcher roles unable to alter authority, money, immutable payloads or foreign Redis keys", async () => {
    const role = (
      await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
    ).rows[0]
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
    await expect(runtime.query("UPDATE \"Scan\" SET status='RUNNING'")).rejects.toMatchObject({
      code: "42501",
    })
    await expect(
      runtime.query('UPDATE "ScanQueueOutbox" SET "payloadDigest"=repeat(\'a\',64)')
    ).rejects.toMatchObject({ code: "42501" })
    await expect(
      runtime.query("UPDATE \"ScanDispatchOperation\" SET state='ACTIVE'")
    ).rejects.toMatchObject({ code: "42501" })
    await expect(
      runtime.query('INSERT INTO "ScanDispatchAttempt" ("operationId") VALUES (\'forbidden\')')
    ).rejects.toMatchObject({ code: "42501" })
    const redis = await getScanQueue().getBackend().client
    await expect(redis.get("foreign-fixture-key")).rejects.toThrow("NOPERM")
    await expect(redis.flushall()).rejects.toThrow("NOPERM")
  })
})
