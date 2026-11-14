import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { canonicalizeJson, sha256Sync } from "@lyrashield/security/webmcp"
import { createBrokerService } from "../../../apps/broker/src/service"
import {
  createScanDispatchAuthorityBroker,
  type PrepareDispatchResult,
} from "./scan-dispatch-authority-broker"
import {
  compilePreparationCommand,
  readStoredDispatchCommand,
  type ScanPreparationCompiler,
} from "./scan-dispatch-command-descriptor"
import {
  applyPreparationFixtureMigration,
  installPreparationFixtureRole,
  preparationFixture,
  preparationInput,
} from "../scripts/tests/scan-preparation-fixture"
import { queueFixtureWorker } from "../scripts/tests/queue-outbox-fixture"

// Hoisting runs this guard before imports can construct a client from ambient
// env. Bind the fixture's privileged DATABASE_URL role to its restricted
// preparation broker role through the shared disposable-pair guard.
await vi.hoisted(async () => {
  const runtime = process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1" || !runtime) return
  const { assertDisposableDatabasePair } =
    await import("../../../.github/scripts/vitest-database-env.mjs")
  assertDisposableDatabasePair({ ...process.env, RLS_RUNTIME_DATABASE_URL: runtime })
})

const enabled =
  process.env.SCAN_DISPATCH_AUTHORITY_POSTGRES_TEST === "1" &&
  process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1"
let owner: pg.Pool
const queueWorker = queueFixtureWorker()
const compile = vi.fn<ScanPreparationCompiler>((authority) => ({
  executors: [
    {
      key: "engine",
      spec: {
        kind: "process",
        command: "/opt/approved/engine",
        args: ["--review"],
        cwd: "/var/lib/approved/checkout",
        cgroupPath: "/sys/fs/cgroup/approved/engine",
        env: {},
        grantEnvName: "LLM_API_KEY",
      },
    },
  ],
  ...(authority.attempt.billingMode === "PAID"
    ? {
        provider: {
          providerId: "fixture",
          maxRequests: 1,
          costReservationMicros: 1,
          maxReservedCostMicros: 1,
        },
      }
    : {}),
}))
let broker: ReturnType<typeof createScanDispatchAuthorityBroker>
async function stored(commandId: string) {
  return (await owner.query('SELECT * FROM "ScanDispatchOutbox" WHERE id=$1', [commandId])).rows[0]
}

describe.skipIf(!enabled)("persisted canonical controller command descriptors", () => {
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await queueWorker.open()
    await applyPreparationFixtureMigration(owner)
    await installPreparationFixtureRole(owner)
    broker = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
      compilePreparation: compile,
    })
  }, 30000)
  afterAll(async () => {
    await broker?.close()
    await owner?.end()
    await queueWorker.close()
  })

  it("prepares through the packaged broker only with a compiler and a live grant", async () => {
    const config = {
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      transport: { kind: "unix" as const, socketPath: "/run/lyrashield/broker.sock" },
      controlToken: "fixture-control-token-at-least-32-characters",
      admission: "closed" as const,
    }
    const closed = createBrokerService(config)
    const installed = createBrokerService({ ...config, preparationAuthority: compile })
    try {
      const denied = await preparationFixture(owner)
      await expect(closed.prepare(preparationInput(denied))).rejects.toMatchObject({
        code: "PREPARATION_AUTHORITY_CLOSED",
      })
      expect(
        (
          await owner.query(
            'SELECT count(*)::int n FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
            [denied.operationId]
          )
        ).rows[0].n
      ).toBe(0)

      const f = await preparationFixture(owner)
      const prepared = (await installed.prepare(preparationInput(f))) as PrepareDispatchResult
      expect(prepared.kind).toBe("committed")
      if (prepared.kind !== "committed") throw new Error("fixture did not prepare")
      const row = await stored(prepared.commandId)
      expect(
        readStoredDispatchCommand(row.commandInputJson, row.commandInputChecksum)
      ).toMatchObject({
        type: "PREPARE",
        attempt: { operationId: f.operationId, scanId: f.scanId, workspaceId: f.workspaceId },
      })

      const revoked = await preparationFixture(owner)
      await owner.query(
        'UPDATE "ScanWorkerInstanceGrant" SET "revokedAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP WHERE id=$1',
        [revoked.grantId]
      )
      await expect(installed.prepare(preparationInput(revoked))).rejects.toMatchObject({
        code: "WORKER_GRANT_INVALID",
      })
      expect(
        (
          await owner.query(
            'SELECT count(*)::int n FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
            [revoked.operationId]
          )
        ).rows[0].n
      ).toBe(0)
    } finally {
      await Promise.all([closed.close(), installed.close()])
    }
  })

  it("builds identity from locked persistence and ignores worker execution choices", async () => {
    const f = await preparationFixture(owner)
    const input = preparationInput(f)
    const prepared = await broker.prepare({
      ...input,
      argv: ["unapproved"],
      env: { SECRET: "unapproved" },
    } as Parameters<typeof broker.prepare>[0])
    expect(prepared.kind).toBe("committed")
    if (prepared.kind !== "committed") throw new Error("fixture did not prepare")
    const row = await stored(prepared.commandId)
    expect(row.commandInputChecksum).toBe(sha256Sync(row.commandInputJson))
    expect(row.commandDigest).toBe(row.commandInputChecksum)
    const command = readStoredDispatchCommand(row.commandInputJson, row.commandInputChecksum)
    expect(command).toMatchObject({
      type: "PREPARE",
      commandId: row.id,
      attempt: {
        attemptId: prepared.attemptId,
        scanId: f.scanId,
        workspaceId: f.workspaceId,
        operationId: f.operationId,
        authorityEpochId: f.epochId,
        workerIdentity: f.instanceId,
        authorityRevision: 1,
        billingMode: "PAID",
      },
    })
    expect(row.commandInputJson).not.toContain("unapproved")
    expect(compile.mock.calls.at(-1)?.[0]).toMatchObject({
      target: { id: f.targetId, workspaceId: f.workspaceId },
      workerGrantId: f.grantId,
    })
    await expect(
      broker.startPaid({ ...preparationInput(f), attemptId: prepared.attemptId })
    ).rejects.toMatchObject({ code: "PREPARATION_AUTHORITY_CLOSED" })
    const before = compile.mock.calls.length
    expect(await broker.prepare(input)).toMatchObject({
      kind: "committed",
      commandId: row.id,
    })
    expect(compile.mock.calls.length).toBe(before)
    const client = await owner.connect()
    try {
      await expect(
        compilePreparationCommand(
          client,
          { commandId: row.id, attemptId: prepared.attemptId, operationId: f.operationId },
          compile,
          undefined
        )
      ).rejects.toMatchObject({ code: "PREPARATION_AUTHORITY_UNAVAILABLE" })
    } finally {
      client.release()
    }
  })

  it("never backfills unavailable commands, or edits a persisted descriptor", async () => {
    const f = await preparationFixture(owner)
    const noCompiler = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
    })
    try {
      const old = await noCompiler.prepare(preparationInput(f))
      if (old.kind !== "committed") throw new Error("fixture did not prepare")
      const row = await stored(old.commandId)
      expect(readStoredDispatchCommand(row.commandInputJson, row.commandInputChecksum)).toBeNull()
      await expect(
        owner.query(
          'UPDATE "ScanDispatchOutbox" SET "commandInputJson"=\'{}\',"commandInputChecksum"=$2 WHERE id=$1',
          [row.id, sha256Sync("{}")]
        )
      ).rejects.toMatchObject({ code: "23514" })
    } finally {
      await noCompiler.close()
    }
    const next = await preparationFixture(owner)
    const prepared = await broker.prepare(preparationInput(next))
    if (prepared.kind !== "committed") throw new Error("fixture did not prepare")
    await expect(
      owner.query(
        'UPDATE "ScanDispatchOutbox" SET "commandInputJson"=NULL,"commandInputChecksum"=NULL WHERE id=$1',
        [prepared.commandId]
      )
    ).rejects.toMatchObject({ code: "23514" })
  })

  it.each(["commandId", "attemptId", "type", "checksum"])(
    "rejects raw SQL descriptor %s contradictions",
    async (field) => {
      const f = await preparationFixture(owner)
      const prepared = await broker.prepare(preparationInput(f))
      if (prepared.kind !== "committed") throw new Error("fixture did not prepare")
      const commandId = `descriptor-${randomUUID()}`
      const command = {
        type: field === "type" ? "RECONCILE" : "STOP",
        commandId: field === "commandId" ? "foreign-command" : commandId,
        attemptId: field === "attemptId" ? "foreign-attempt" : prepared.attemptId,
        expectedReceiptHash: "a".repeat(64),
      }
      const bytes = canonicalizeJson(command),
        checksum = field === "checksum" ? "b".repeat(64) : sha256Sync(bytes)
      await expect(
        owner.query(
          'INSERT INTO "ScanDispatchOutbox"(id,"operationId","attemptId","commandType",sequence,"commandDigest","commandInputJson","commandInputChecksum","updatedAt") VALUES($1,$2,$3,\'STOP\',3,$4,$5,$4,CURRENT_TIMESTAMP)',
          [commandId, f.operationId, prepared.attemptId, checksum, bytes]
        )
      ).rejects.toMatchObject({ code: "23514" })
    }
  )

  it.each(["total", "request"])(
    "does not persist over-authorized provider %s reservation",
    async (kind) => {
      const f = await preparationFixture(owner)
      const denied = createScanDispatchAuthorityBroker({
        connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
        preparationAuthority: "checked-intent-v1",
        compilePreparation: (authority) => ({
          ...compile(authority),
          provider: {
            providerId: "fixture",
            maxRequests: 1,
            costReservationMicros: kind === "request" ? 2 : 1,
            maxReservedCostMicros: kind === "total" ? 1_000_001 : 1,
          },
        }),
      })
      try {
        await expect(denied.prepare(preparationInput(f))).rejects.toMatchObject({
          code: "PREPARATION_AUTHORITY_UNAVAILABLE",
        })
        expect(
          (
            await owner.query(
              'SELECT count(*)::int n FROM "ScanDispatchOutbox" WHERE "operationId"=$1',
              [f.operationId]
            )
          ).rows[0].n
        ).toBe(0)
      } finally {
        await denied.close()
      }
    }
  )

  it("does not persist paid preparation without provider policy", async () => {
    const f = await preparationFixture(owner)
    const denied = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
      compilePreparation: (authority) => ({ executors: compile(authority).executors }),
    })
    try {
      await expect(denied.prepare(preparationInput(f))).rejects.toMatchObject({
        code: "PREPARATION_AUTHORITY_UNAVAILABLE",
      })
      expect(
        (
          await owner.query(
            'SELECT count(*)::int n FROM "ScanDispatchOutbox" WHERE "operationId"=$1',
            [f.operationId]
          )
        ).rows[0].n
      ).toBe(0)
    } finally {
      await denied.close()
    }
  })

  it("does not persist a provider grant on unmetered preparation", async () => {
    const f = await preparationFixture(owner, 0)
    const denied = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
      compilePreparation: (authority) => ({
        ...compile(authority),
        provider: {
          providerId: "fixture",
          maxRequests: 1,
          costReservationMicros: 0,
          maxReservedCostMicros: 0,
        },
      }),
    })
    try {
      await expect(denied.prepare(preparationInput(f))).rejects.toMatchObject({
        code: "PREPARATION_AUTHORITY_UNAVAILABLE",
      })
      expect(
        (
          await owner.query(
            'SELECT count(*)::int n FROM "ScanDispatchOutbox" WHERE "operationId"=$1',
            [f.operationId]
          )
        ).rows[0].n
      ).toBe(0)
    } finally {
      await denied.close()
    }
  })

  it("rolls back compilation failure without leaving executable or command intent", async () => {
    const f = await preparationFixture(owner)
    const closed = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
      compilePreparation: () => {
        throw new Error("compiler unavailable")
      },
    })
    try {
      await expect(closed.prepare(preparationInput(f))).rejects.toMatchObject({
        code: "DATABASE_REJECTED",
      })
      expect(
        (
          await owner.query(
            'SELECT count(*)::int n FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
            [f.operationId]
          )
        ).rows[0].n
      ).toBe(0)
      expect(
        (
          await owner.query(
            'SELECT count(*)::int n FROM "ScanDispatchOutbox" WHERE "operationId"=$1',
            [f.operationId]
          )
        ).rows[0].n
      ).toBe(0)
    } finally {
      await closed.close()
    }
  })
})
