import { createHash } from "node:crypto"
import pg from "pg"
import { chmod, mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest"
import { hasPermission, PERMISSIONS } from "../../auth/src/permissions"
import {
  resolveScanProfile,
  buildScanExecutionPlan,
  ScanExecutionPlanSchema,
} from "@lyrashield/types"
import { computeScanExecutionPlanHash, canonicalizeScanExecutionPlan } from "./scan-execution-plan"
import { createScanDispatchAuthorityBroker } from "./scan-dispatch-authority-broker"
import {
  assertDispatchStopRolePrerequisites,
  bindScanPreparationContext,
  checkPreparationAuthority,
} from "./scan-preparation-authority"
import {
  preparationFixture,
  preparationInput,
  fixturePreparationCompiler,
  applyPreparationFixtureMigration,
  installPreparationFixtureRole,
  installPreparationRevokerRole,
  insertPreparationAttempt,
  sealPreparationBundle,
  legacyPreparationFixture,
  type PreparationFixture,
} from "../scripts/tests/scan-preparation-fixture"
import { queueFixtureWorker } from "../scripts/tests/queue-outbox-fixture"
import {
  PostgresScanAuthorityFence,
  type AuthorityAction,
} from "../../runtime-control/src/authority-fence"
import { DockerRuntimeExecutor } from "../../../apps/supervisor/src/executor"

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
let owner: pg.Pool,
  runtime: pg.Pool,
  writer: pg.Pool,
  broker: ReturnType<typeof createScanDispatchAuthorityBroker>
const queueWorker = queueFixtureWorker()
async function writerTransaction(f: PreparationFixture) {
  const c = await writer.connect()
  await c.query("BEGIN")
  await c.query(
    "SELECT set_config('app.current_workspace_id',$1,true),set_config('app.current_account_id',$2,true)",
    [f.workspaceId, f.userId]
  )
  return c
}
async function lockedClient(f: PreparationFixture, isolation = "READ COMMITTED") {
  const c = await runtime.connect()
  await c.query(`BEGIN ISOLATION LEVEL ${isolation}`)
  await bindScanPreparationContext(c, f.operationId)
  return c
}
async function waitingForLock(mode: string) {
  for (let i = 0; i < 100; i++) {
    const rows = await owner.query(
      "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=1819234670 AND objid=1 AND mode=$1 AND NOT granted",
      [mode]
    )
    if (rows.rowCount) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error("Fixture lock wait did not materialize")
}

describe.skipIf(!enabled)("checked preparation intent authority", () => {
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
    owner.on("error", () => {})
    await queueWorker.open()
    await applyPreparationFixtureMigration(owner)
    await installPreparationFixtureRole(owner)
    await installPreparationRevokerRole(owner)
    runtime = new pg.Pool({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL,
      max: 4,
    })
    runtime.on("error", () => {})
    writer = new pg.Pool({ connectionString: process.env.RLS_RUNTIME_DATABASE_URL, max: 3 })
    broker = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
      compilePreparation: fixturePreparationCompiler,
    })
  }, 30000)
  afterAll(async () => {
    await broker?.close()
    await runtime?.end()
    await writer?.end()
    await owner?.end()
    await queueWorker.close()
  })
  it("defaults closed and keeps both start methods structurally closed", async () => {
    const f = await preparationFixture(owner),
      input = preparationInput(f)
    const closed = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
    })
    try {
      await expect(closed.prepare(input)).rejects.toMatchObject({
        code: "PREPARATION_AUTHORITY_CLOSED",
      })
    } finally {
      await closed.close()
    }
    const prepared = await broker.prepare(input)
    expect(prepared.kind).toBe("committed")
    if (prepared.kind !== "committed") throw new Error("fixture did not commit")
    const start = { ...input, attemptId: prepared.attemptId }
    await expect(broker.startPaid(start)).rejects.toMatchObject({
      code: "PREPARATION_AUTHORITY_CLOSED",
    })
    await expect(broker.startUnmetered(start)).rejects.toMatchObject({
      code: "PREPARATION_AUTHORITY_CLOSED",
    })
    expect(
      (
        await owner.query(
          'SELECT count(*)::int n FROM "ScanDispatchStart" WHERE "operationId"=$1',
          [f.operationId]
        )
      ).rows[0].n
    ).toBe(0)
  })
  it.each(["member", "sponsor"])(
    "serializes %s revocation before preparation and reads the new state",
    async (kind) => {
      const f = await preparationFixture(owner),
        c = await writerTransaction(f)
      try {
        await c.query(
          kind === "member"
            ? 'UPDATE "WorkspaceMember" SET status=\'removed\' WHERE "workspaceId"=$1'
            : 'UPDATE "Workspace" SET "agencySponsorAccountId"=\'different-sponsor\' WHERE id=$1',
          [f.workspaceId]
        )
        await expect(broker.prepare(preparationInput(f))).rejects.toMatchObject({
          code: "PREPARATION_AUTHORITY_BUSY",
        })
        await c.query("COMMIT")
        await expect(broker.prepare(preparationInput(f))).rejects.toMatchObject({
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
      } finally {
        await c.query("ROLLBACK")
        c.release()
      }
    }
  )
  it("holds actual revocation through a fenced invocation and denies the next invocation", async () => {
    const f = await preparationFixture(owner)
    const binding: AuthorityAction = {
      phase: "PREPARE",
      operationId: f.operationId,
      attemptId: "native-fixture-attempt",
      commandId: "native-fixture-command",
      workspaceId: f.workspaceId,
      scanId: f.scanId,
      authorityEpochId: f.epochId,
      authorityRevision: 1,
      authorityChecksum: "a".repeat(64),
      actionChecksum: "b".repeat(64),
    }
    // This real DB fixture qualifies the preparation fence's lifetime only.
    const fence = new PostgresScanAuthorityFence(runtime, async (client, action) => {
      if (action.phase !== "PREPARE")
        throw new Error("Physical authority is not qualified by this fixture")
      const context = (
        await client.query("SELECT * FROM app.scan_preparation_context($1)", [action.operationId])
      ).rows[0]
      if (!context || context.workspaceId !== action.workspaceId)
        throw new Error("Context unavailable")
      await client.query(
        "SELECT set_config('app.current_workspace_id',$1,true),set_config('app.current_account_id',$2,true),set_config('app.current_scan_user_id',$3,true)",
        [String(context.workspaceId), String(context.accountId), String(context.userId)]
      )
      const checked = (
        await client.query(
          "SELECT \"deadlineAt\" AT TIME ZONE 'UTC' AS deadline FROM app.check_scan_preparation_authority($1,(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 minute')",
          [action.scanId]
        )
      ).rows[0]
      if (!(checked?.deadline instanceof Date)) throw new Error("Native authority unavailable")
      return { deadlineAt: checked.deadline }
    })
    let notifyEntered!: () => void, releaseEffect!: () => void
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve
    })
    const resume = new Promise<void>((resolve) => {
      releaseEffect = resolve
    })
    let effects = 0
    const invocation = fence.run(binding, async (assertActive) => {
      assertActive()
      effects++
      notifyEntered()
      await resume
      assertActive()
      return "acknowledged"
    })
    const w = await writerTransaction(f)
    let revoked = false
    try {
      await entered
      const revocation = w
        .query('UPDATE "WorkspaceMember" SET status=\'removed\' WHERE "workspaceId"=$1', [
          f.workspaceId,
        ])
        .then(() => {
          revoked = true
        })
      await waitingForLock("ShareLock")
      expect(revoked).toBe(false)
      releaseEffect()
      expect(await invocation).toBe("acknowledged")
      await revocation
      await w.query("COMMIT")
      await expect(
        fence.run(binding, () => {
          effects++
        })
      ).rejects.toThrow("membership revoked")
      expect(effects).toBe(1)
    } finally {
      releaseEffect()
      await invocation.catch(() => undefined)
      await w.query("ROLLBACK")
      w.release()
    }
  })

  it("does not start an executor after a real fenced database session is terminated", async () => {
    const f = await preparationFixture(owner)
    const root = await mkdtemp(join(tmpdir(), "native-fence-executor-"))
    const docker = join(root, "docker")
    const marker = join(root, "mutated")
    await writeFile(docker, `#!/bin/sh\ntouch '${marker}'\n`)
    await chmod(docker, 0o700)
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`)
    const executor = new DockerRuntimeExecutor()
    const ownership = {
      executorKey: "engine" as const,
      kind: "container" as const,
      ownershipId: `own_${"a".repeat(40)}`,
      containerId: "b".repeat(64),
    }
    let enter!: () => void,
      resume!: () => void,
      backendPid = 0
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const continueInspection = new Promise<void>((resolve) => {
      resume = resolve
    })
    vi.spyOn(executor, "inspect").mockImplementation(async () => {
      enter()
      await continueInspection
      return { state: "PRESENT", running: false, ownership }
    })
    const fence = new PostgresScanAuthorityFence(runtime, async (client, action) => {
      const context = (
        await client.query("SELECT * FROM app.scan_preparation_context($1)", [action.operationId])
      ).rows[0]
      if (!context || context.workspaceId !== action.workspaceId)
        throw new Error("Context unavailable")
      await client.query(
        "SELECT set_config('app.current_workspace_id',$1,true),set_config('app.current_account_id',$2,true),set_config('app.current_scan_user_id',$3,true)",
        [String(context.workspaceId), String(context.accountId), String(context.userId)]
      )
      const checked = (
        await client.query(
          "SELECT pg_backend_pid() AS pid, \"deadlineAt\" AT TIME ZONE 'UTC' AS deadline FROM app.check_scan_preparation_authority($1,(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 minute')",
          [action.scanId]
        )
      ).rows[0]
      if (!(checked?.deadline instanceof Date) || typeof checked.pid !== "number")
        throw new Error("Native authority unavailable")
      backendPid = checked.pid
      return { deadlineAt: checked.deadline }
    })
    const binding: AuthorityAction = {
      phase: "EXECUTOR_START",
      operationId: f.operationId,
      attemptId: "native-fixture-attempt",
      commandId: "native-fixture-command",
      workspaceId: f.workspaceId,
      scanId: f.scanId,
      authorityEpochId: f.epochId,
      authorityRevision: 1,
      executorKey: "engine",
      authorityChecksum: "a".repeat(64),
      actionChecksum: "b".repeat(64),
    }
    const spec = {
      kind: "container" as const,
      image: `fixture@sha256:${"a".repeat(64)}`,
      argv: [],
      env: {},
      network: "fixture",
      cpus: 1,
      memoryMb: 64,
      pidsLimit: 16,
      readOnly: true,
      grantEnvName: "LLM_API_KEY",
    }
    let start: Promise<unknown> | undefined
    const invocation = fence.run(binding, (assertActive) => {
      start = executor.start(ownership, spec, {
        attemptId: binding.attemptId,
        commandId: binding.commandId!,
        assertActive,
      })
      return start
    })
    const result = invocation.catch((error: unknown) => error)
    try {
      await Promise.race([
        entered,
        invocation.then(() => {
          throw new Error("inspection not reached")
        }),
      ])
      expect(backendPid).toBeGreaterThan(0)
      expect(
        (await owner.query("SELECT pg_terminate_backend($1) AS stopped", [backendPid])).rows[0]
          ?.stopped
      ).toBe(true)
      expect(await result).toBeInstanceOf(Error)
      resume()
      await expect(start).rejects.toThrow()
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      resume()
      await result
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("holds later revocation until preparation transaction commit and releases on rollback", async () => {
    const f = await preparationFixture(owner),
      c = await lockedClient(f),
      w = await writerTransaction(f)
    try {
      expect(
        (await c.query("SELECT app.acquire_scan_preparation_gate() acquired")).rows[0].acquired
      ).toBe(true)
      await c.query(
        "SELECT * FROM app.check_scan_preparation_authority($1,(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 minute')",
        [f.scanId]
      )
      let done = false
      const revoke = w
        .query('UPDATE "WorkspaceMember" SET status=\'removed\' WHERE "workspaceId"=$1', [
          f.workspaceId,
        ])
        .then(() => {
          done = true
        })
      await waitingForLock("ShareLock")
      expect(done).toBe(false)
      await c.query("ROLLBACK")
      await revoke
      await w.query("COMMIT")
      await expect(broker.prepare(preparationInput(f))).rejects.toMatchObject({
        code: "DATABASE_REJECTED",
      })
    } finally {
      await c.query("ROLLBACK")
      await w.query("ROLLBACK")
      c.release()
      w.release()
    }
  })
  it.each(["REPEATABLE READ", "SERIALIZABLE"])(
    "rejects %s even after a stale snapshot",
    async (isolation) => {
      const f = await preparationFixture(owner),
        c = await lockedClient(f, isolation)
      try {
        await c.query('SELECT id FROM "Scan" WHERE id=$1', [f.scanId])
        await expect(c.query("SELECT app.acquire_scan_preparation_gate()")).rejects.toThrow(
          "READ COMMITTED"
        )
      } finally {
        await c.query("ROLLBACK")
        c.release()
      }
    }
  )
  it("denies broker source DML, app private writes, context definer, TRUNCATE and DDL", async () => {
    await expect(
      writer.query("SELECT * FROM app.scan_preparation_context('anything')")
    ).rejects.toMatchObject({ code: "42501" })
    await expect(
      runtime.query("UPDATE \"WorkspaceMember\" SET status='removed'")
    ).rejects.toMatchObject({ code: "42501" })
    await expect(runtime.query('TRUNCATE "WorkspaceMember"')).rejects.toMatchObject({
      code: "42501",
    })
    await expect(runtime.query("CREATE TEMP TABLE spoof(id int)")).rejects.toMatchObject({
      code: "42501",
    })
    await expect(
      runtime.query('ALTER TABLE "WorkspaceMember" DISABLE TRIGGER ALL')
    ).rejects.toMatchObject({ code: "42501" })
    await expect(runtime.query("SET ROLE dispatch_authority_runtime")).rejects.toMatchObject({
      code: "42501",
    })
    await expect(runtime.query("SET session_replication_role=replica")).rejects.toMatchObject({
      code: "42501",
    })
    await expect(
      writer.query('INSERT INTO "ScanDispatchAttempt"("operationId") VALUES(\'spoof\')')
    ).rejects.toMatchObject({ code: "42501" })
  })
  it("rejects mixed effective writer privileges and reachable definers", async () => {
    await owner.query('GRANT UPDATE(status) ON "WorkspaceMember" TO dispatch_prepare_broker')
    try {
      await expect(runtime.query("SELECT app.require_scan_preparation_role()")).rejects.toThrow(
        "writer privileges"
      )
    } finally {
      await owner.query('REVOKE UPDATE(status) ON "WorkspaceMember" FROM dispatch_prepare_broker')
    }
    await owner.query(
      "GRANT EXECUTE ON FUNCTION app.touch_api_key_last_used(text) TO dispatch_prepare_broker"
    )
    try {
      await expect(runtime.query("SELECT app.require_scan_preparation_role()")).rejects.toThrow(
        "unreviewed definer"
      )
    } finally {
      await owner.query(
        "REVOKE EXECUTE ON FUNCTION app.touch_api_key_last_used(text) FROM dispatch_prepare_broker"
      )
    }
  })
  it("derives UTC wall-clock authority without refreshing replay or xid", async () => {
    const f = await preparationFixture(owner),
      input = preparationInput(f)
    const first = await broker.prepare(input)
    expect(first.kind).toBe("committed")
    const second = await broker.prepare(input)
    expect(second).toEqual(first)
    const c = await lockedClient(f)
    try {
      await c.query("SET LOCAL timezone='Pacific/Honolulu'")
      const clock = (await c.query("SELECT clock_timestamp() clock")).rows[0].clock
      const authority = await checkPreparationAuthority(
        c,
        { ...f, state: "PREPARING", requestDigest: "", sponsorAccountId: f.userId },
        input.expiresAt.toISOString().replace("T", " ").replace("Z", "")
      )
      expect(Math.abs(authority.authorityAcceptedAt.getTime() - clock.getTime())).toBeLessThan(1000)
    } finally {
      await c.query("ROLLBACK")
      c.release()
    }
    const row = (
      await owner.query(
        'SELECT "authorityTransactionId",("authorityDeadlineAt"-"authorityAcceptedAt")=interval \'10 seconds\' bounded FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
        [f.operationId]
      )
    ).rows[0]
    expect(row).toEqual({ authorityTransactionId: expect.stringMatching(/^\d+$/), bounded: true })
  })
  it.each([
    { authorityAcceptedAt: new Date() },
    { authorityTransactionId: "spoof" },
    { authorityDeadlineAt: "infinity" as const },
  ])("rejects caller metadata %j", async (authorityMetadata) => {
    const f = await preparationFixture(owner),
      c = await lockedClient(f)
    try {
      await c.query("SELECT app.acquire_scan_preparation_gate()")
      await expect(insertPreparationAttempt(c, f, { authorityMetadata })).rejects.toThrow(
        "server-derived"
      )
    } finally {
      await c.query("ROLLBACK")
      c.release()
    }
  })
  it("rejects direct inserts, incomplete bundle and SET CONSTRAINTS IMMEDIATE", async () => {
    const f = await preparationFixture(owner),
      c = await lockedClient(f)
    try {
      await expect(insertPreparationAttempt(c, f)).rejects.toThrow("exclusive authority gate")
    } finally {
      await c.query("ROLLBACK")
      c.release()
    }
    const b = await lockedClient(f)
    try {
      await b.query("SELECT app.acquire_scan_preparation_gate()")
      await insertPreparationAttempt(b, f)
      await expect(b.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toThrow("bundle is incomplete")
    } finally {
      await b.query("ROLLBACK")
      b.release()
    }
    expect(
      (
        await owner.query(
          'SELECT count(*)::int n FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
          [f.operationId]
        )
      ).rows[0].n
    ).toBe(0)
  })
  it("denies same-transaction source writes after acquiring preparation authority", async () => {
    const f = await preparationFixture(owner),
      c = await owner.connect()
    try {
      await c.query("BEGIN")
      await c.query("SELECT pg_advisory_xact_lock(1819234670,1)")
      await expect(
        c.query('UPDATE "WorkspaceMember" SET status=\'removed\' WHERE "workspaceId"=$1', [
          f.workspaceId,
        ])
      ).rejects.toThrow("writes are forbidden")
    } finally {
      await c.query("ROLLBACK")
      c.release()
    }
  })
  it("preserves canonical executable operational permissions and repository ceilings", () => {
    for (const role of [
      "OWNER",
      "ADMIN",
      "SECURITY_ADMIN",
      "APPSEC_MANAGER",
      "BILLING_ADMIN",
      "DEVELOPER",
      "MEMBER",
      "EXTERNAL_PENTESTER",
      "AUDITOR",
      "VIEWER",
    ] as const)
      for (const permission of [
        PERMISSIONS.scan.create,
        PERMISSIONS.retest.create,
        PERMISSIONS.schedule.create,
      ])
        expect(hasPermission(role, permission)).toBe(true)
    for (const [mode, budget, duration] of [
      ["SAFE", 1.2, 23],
      ["QUICK", 1.2, 23],
      ["STANDARD", 3.2, 23],
      ["DEEP", 5, 45],
      ["CUSTOM", 5, 45],
    ] as const) {
      const p = resolveScanProfile({ targetType: "REPO", mode })
      expect(p.maxBudgetUsd).toBe(budget)
      expect(p.maxDurationMinutes).toBe(duration)
    }
  })
  it("closes unsupported attachments and rejects broker preparation under a writer identity", async () => {
    const f = await preparationFixture(owner, 1, "attachment", {
      targetType: "REPO",
      mode: "SAFE",
      attachmentIds: ["uncovered"],
    })
    await expect(broker.prepare(preparationInput(f))).rejects.toMatchObject({
      code: "DATABASE_REJECTED",
    })
    const mixed = createScanDispatchAuthorityBroker({
      connectionString: process.env.DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
      compilePreparation: fixturePreparationCompiler,
    })
    try {
      await expect(mixed.prepare(preparationInput(f))).rejects.toMatchObject({
        code: "DATABASE_REJECTED",
      })
    } finally {
      await mixed.close()
    }
  })
  it("commits a complete fenced bundle before a waiting revocation and never replays after it", async () => {
    const f = await preparationFixture(owner),
      c = await lockedClient(f),
      w = await writerTransaction(f)
    try {
      await c.query("SELECT app.acquire_scan_preparation_gate()")
      const attemptId = await insertPreparationAttempt(c, f)
      await sealPreparationBundle(c, f, attemptId)
      await c.query("SET CONSTRAINTS ALL IMMEDIATE")
      const revoke = w.query(
        'UPDATE "WorkspaceMember" SET status=\'removed\' WHERE "workspaceId"=$1',
        [f.workspaceId]
      )
      await waitingForLock("ShareLock")
      await c.query("COMMIT")
      await revoke
      await w.query("COMMIT")
      await expect(broker.prepare(preparationInput(f))).rejects.toMatchObject({
        code: "DATABASE_REJECTED",
      })
      expect(
        (
          await owner.query('SELECT state FROM "ScanDispatchOperation" WHERE "operationId"=$1', [
            f.operationId,
          ])
        ).rows[0].state
      ).toBe("PREPARING")
      expect(
        (
          await owner.query(
            'SELECT count(*)::int n FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
            [f.operationId]
          )
        ).rows[0].n
      ).toBe(1)
    } finally {
      await c.query("ROLLBACK")
      await w.query("ROLLBACK")
      c.release()
      w.release()
    }
  })
  it.each(["revoked", "expired", "rescope"])(
    "rejects %s delegation and preserves separate outer identity",
    async (kind) => {
      const f = await preparationFixture(owner, 1, "delegated", undefined, true)
      const before = await owner.query(
        'SELECT p."operationId",p."connectionId",o."principalId" FROM delegated_scan_provenance p JOIN agent_operations o ON o.id=p."operationId" WHERE p."scanId"=$1',
        [f.scanId]
      )
      expect(before.rows[0].operationId).not.toBe(f.operationId)
      expect(before.rows[0].principalId).toBe(before.rows[0].connectionId)
      const c = await writerTransaction(f)
      try {
        await c.query(
          kind === "revoked"
            ? 'UPDATE agent_connections SET status=\'REVOKED\',"revokedAt"=CURRENT_TIMESTAMP WHERE "workspaceId"=$1'
            : kind === "expired"
              ? 'UPDATE agent_connections SET "expiresAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE "workspaceId"=$1'
              : 'UPDATE agent_connections SET "allowedOperations"=ARRAY[]::text[] WHERE "workspaceId"=$1',
          [f.workspaceId]
        )
        await expect(broker.prepare(preparationInput(f))).rejects.toMatchObject({
          code: "PREPARATION_AUTHORITY_BUSY",
        })
        await c.query("COMMIT")
        await expect(broker.prepare(preparationInput(f))).rejects.toMatchObject({
          code: "DATABASE_REJECTED",
        })
        expect(
          (
            await owner.query(
              'SELECT "operationId" FROM delegated_scan_provenance WHERE "scanId"=$1',
              [f.scanId]
            )
          ).rows[0].operationId
        ).toBe(before.rows[0].operationId)
      } finally {
        await c.query("ROLLBACK")
        c.release()
      }
    }
  )
  it("does not truncate active paid authority with an expired historical trial", async () => {
    const f = await preparationFixture(owner)
    await owner.query(
      "UPDATE users SET \"trialStartedAt\"=CURRENT_TIMESTAMP-interval '30 days' WHERE id=$1",
      [f.userId]
    )
    const r = await broker.prepare(preparationInput(f))
    expect(r.kind).toBe("committed")
    if (r.kind !== "committed") throw new Error("fixture commit unavailable")
    expect(r.authorityDeadlineAt.getTime() - r.authorityAcceptedAt.getTime()).toBe(10000)
  })
  it("binds a controlling canceled-subscription expiry without rounding it forward", async () => {
    const f = await preparationFixture(owner)
    const row = (
      await owner.query(
        "UPDATE \"BillingAccount\" SET status='canceled',\"currentPeriodEnd\"=date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC')+interval '2 seconds' WHERE \"accountId\"=$1 RETURNING \"currentPeriodEnd\" AT TIME ZONE 'UTC' AS expiry",
        [f.userId]
      )
    ).rows[0]
    const r = await broker.prepare(preparationInput(f))
    expect(r.kind).toBe("committed")
    if (r.kind !== "committed") throw new Error("fixture commit unavailable")
    expect(r.authorityDeadlineAt.getTime()).toBe(row.expiry.getTime())
  })
  it("preserves late durable PREPARING history, reports transport UNKNOWN and never refreshes expiry", async () => {
    const arm = process.env.DELAY_ARM_PATH!,
      marker = process.env.DELAY_MARKER_PATH!,
      f = await preparationFixture(owner),
      input = preparationInput(f)
    await writeFile(arm, "delay", { flag: "wx", mode: 0o600 })
    expect(await broker.prepare(input)).toEqual({
      kind: "unknown",
      operationId: f.operationId,
      reasonCode: "PREPARATION_ACKNOWLEDGEMENT_DEADLINE",
    })
    expect(await readFile(marker, "utf8")).toBe("dispatch-prepare-commit-response-delayed\n")
    const original = (
      await owner.query(
        'SELECT "authorityAcceptedAt","authorityDeadlineAt","authorityTransactionId" FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
        [f.operationId]
      )
    ).rows[0]
    await expect(broker.status(f.operationId)).resolves.toMatchObject({
      kind: "available",
      state: "PREPARING",
      preparationEligibility: "EXPIRED",
      attemptId: expect.any(String),
    })
    await expect(broker.prepare(input)).rejects.toMatchObject({
      code: "PREPARATION_AUTHORITY_UNAVAILABLE",
    })
    expect(
      (
        await owner.query(
          'SELECT "authorityAcceptedAt","authorityDeadlineAt","authorityTransactionId" FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
          [f.operationId]
        )
      ).rows[0]
    ).toEqual(original)
    const attemptId = (
      await owner.query('SELECT "attemptId" FROM "ScanDispatchAttempt" WHERE "operationId"=$1', [
        f.operationId,
      ])
    ).rows[0].attemptId
    await expect(
      broker.stop({ ...input, attemptId, reasonCode: "USER_CANCELLED" })
    ).resolves.toMatchObject({ kind: "committed", state: "STOPPING" })
  }, 20000)
  it("keeps historical null authority visible and stoppable but unavailable to new preparation", async () => {
    const f = await legacyPreparationFixture(owner)
    await expect(broker.status(f.operationId)).resolves.toMatchObject({
      kind: "available",
      state: "PREPARING",
      preparationEligibility: "UNAVAILABLE",
      attemptId: expect.any(String),
    })
    await expect(broker.prepare(preparationInput(f))).rejects.toMatchObject({
      code: "PREPARATION_AUTHORITY_UNAVAILABLE",
    })
    await expect(
      broker.stop({
        ...preparationInput(f),
        attemptId: `${f.operationId}-attempt`,
        reasonCode: "USER_CANCELLED",
      })
    ).resolves.toMatchObject({ kind: "committed", state: "STOPPING" })
  })
  it("blocks direct PREPARE leasing, post-transaction PREPARE insertion and physical consumption", async () => {
    const f = await preparationFixture(owner),
      r = await broker.prepare(preparationInput(f))
    if (r.kind !== "committed") throw new Error("fixture commit unavailable")
    await expect(
      owner.query(
        "UPDATE \"ScanDispatchOutbox\" SET status='LEASED',\"leaseOwner\"='spoof',\"leaseExpiresAt\"=CURRENT_TIMESTAMP+interval '1 minute' WHERE id=$1",
        [r.commandId]
      )
    ).rejects.toThrow("consumption is closed")
    await expect(
      owner.query(
        'INSERT INTO "ScanPhysicalExecutionTransition"("attemptId","operationId","toState") VALUES($1,$2,\'PREPARING\')',
        [r.attemptId, f.operationId]
      )
    ).rejects.toThrow("checked execution consumption is not qualified")
    // Trigger checks run before required-field/FK checks; a late PREPARE cannot revive intent.
    await expect(
      owner.query(
        'INSERT INTO "ScanDispatchOutbox"("attemptId","operationId","commandType",sequence,status) VALUES($1,$2,\'PREPARE\',1,\'PENDING\')',
        [r.attemptId, f.operationId]
      )
    ).rejects.toThrow("original live transaction bundle")
  })
  it("keeps a cancelled checked attempt held when only a forged receipt exists", async () => {
    const f = await preparationFixture(owner)
    const prepared = await broker.prepare(preparationInput(f))
    if (prepared.kind !== "committed") throw new Error("fixture commit unavailable")
    const stopped = await broker.stop({
      ...preparationInput(f),
      attemptId: prepared.attemptId,
      reasonCode: "USER_CANCELLED",
    })
    expect(stopped).toMatchObject({ kind: "committed", state: "STOPPING" })

    await expect(
      runtime.query('INSERT INTO "ScanSupervisorReceipt" DEFAULT VALUES')
    ).rejects.toMatchObject({ code: "42501" })
    await expect(
      writer.query('INSERT INTO "ScanSupervisorReceipt" DEFAULT VALUES')
    ).rejects.toMatchObject({ code: "42501" })
    const hash = createHash("sha256").update(f.operationId).digest("hex")
    await owner.query(
      `INSERT INTO "ScanSupervisorReceipt" ("id","supervisorInstanceId","operationId","attemptId","authorityEpochId","commandId",sequence,"previousReceiptHash","receiptHash",signature,"receiptType","evidenceDigest","observedAt") VALUES ($1,$2,$3,$4,$5,$6,1,NULL,$7,$8,'NEVER_DISPATCHED',$7,CURRENT_TIMESTAMP)`,
      [
        `forged-${f.operationId}`,
        `forged-supervisor-${f.operationId}`,
        f.operationId,
        prepared.attemptId,
        f.epochId,
        prepared.commandId,
        hash,
        "x".repeat(64),
      ]
    )
    await expect(
      owner.query(
        `UPDATE "ScanDispatchOutbox" SET status='REJECTED',"deliveredAt"=CURRENT_TIMESTAMP WHERE id=$1`,
        [prepared.commandId]
      )
    ).rejects.toThrow("checked preparation consumption is closed")
    await expect(
      owner.query(
        `INSERT INTO "ScanPhysicalExecutionTransition"(id,"operationId","attemptId",revision,"fromState","toState","supervisorReceiptId") VALUES($1,$2,$3,2,'RESERVED','NEVER_DISPATCHED',$4)`,
        [
          `transition-${f.operationId}`,
          f.operationId,
          prepared.attemptId,
          `forged-${f.operationId}`,
        ]
      )
    ).rejects.toThrow("terminal physical release requires every command resolved")
    const held = await owner.query(
      `SELECT o.state::text AS operation, p.state::text AS physical, c.status::text AS command,
         r.state::text AS capacity, EXISTS(SELECT 1 FROM "UserScanSlot" s WHERE s."scanId"=$2) AS slot
       FROM "ScanDispatchOperation" o JOIN "ScanPhysicalExecution" p ON p."operationId"=o."operationId"
       JOIN "ScanDispatchOutbox" c ON c.id=$3 JOIN "ScanCapacityReservation" r ON r."scanId"=$2
       WHERE o."operationId"=$1`,
      [f.operationId, f.scanId, prepared.commandId]
    )
    expect(held.rows).toEqual([
      {
        operation: "STOPPING",
        physical: "RESERVED",
        command: "PENDING",
        capacity: "RESERVED",
        slot: true,
      },
    ])
  })
  it("allows a separately provisioned restricted broker to read and stop a historical attempt", async () => {
    const f = await legacyPreparationFixture(owner)
    const closed = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
    })
    try {
      await expect(closed.status(f.operationId)).resolves.toMatchObject({
        kind: "available",
        state: "PREPARING",
      })
      await owner.query(
        "REVOKE EXECUTE ON FUNCTION app.scan_preparation_context(text) FROM dispatch_prepare_broker"
      )
      try {
        await expect(closed.status(f.operationId)).resolves.toMatchObject({
          kind: "unknown",
          reasonCode: "STATUS_UNAVAILABLE",
        })
        await expect(
          closed.stop({
            ...preparationInput(f),
            attemptId: `${f.operationId}-attempt`,
            reasonCode: "USER_CANCELLED",
          })
        ).rejects.toMatchObject({ code: "DATABASE_REJECTED" })
      } finally {
        await owner.query(
          "GRANT EXECUTE ON FUNCTION app.scan_preparation_context(text) TO dispatch_prepare_broker"
        )
      }
      await expect(
        closed.stop({
          ...preparationInput(f),
          attemptId: `${f.operationId}-attempt`,
          reasonCode: "USER_CANCELLED",
        })
      ).resolves.toMatchObject({ kind: "committed", state: "STOPPING" })
    } finally {
      await closed.close()
    }
  })
  it("requires the explicitly provisioned restricted identity for the status/STOP preflight", async () => {
    const restricted = await runtime.connect()
    const app = await writer.connect()
    try {
      await expect(
        assertDispatchStopRolePrerequisites(restricted, "dispatch_prepare_broker")
      ).resolves.toBeUndefined()
      await expect(
        assertDispatchStopRolePrerequisites(restricted, "other_broker")
      ).rejects.toThrow()
      await expect(
        assertDispatchStopRolePrerequisites(app, "dispatch_authority_runtime")
      ).rejects.toThrow()
    } finally {
      restricted.release()
      app.release()
    }
  })
  it("binds immutable REVIEW_CHANGES source revisions and rejects goal mismatch", async () => {
    const f = await preparationFixture(owner, 1, "diff", {
      targetType: "REPO",
      mode: "SAFE",
      workflow: "REVIEW_CHANGES",
      source: {
        revision: "a".repeat(40),
        baseRevision: "b".repeat(40),
        mergeBaseRevision: "c".repeat(40),
      },
    })
    expect((await broker.prepare(preparationInput(f))).kind).toBe("committed")
    const invalid = await preparationFixture(owner, 1, "diff-mismatch", {
      targetType: "REPO",
      mode: "SAFE",
      workflow: "REVIEW_CHANGES",
      source: {
        revision: "a".repeat(40),
        baseRevision: "b".repeat(40),
        mergeBaseRevision: "c".repeat(40),
      },
    })
    await owner.query("UPDATE \"Scan\" SET goal='TEST_APP' WHERE id=$1", [invalid.scanId])
    await expect(broker.prepare(preparationInput(invalid))).rejects.toMatchObject({
      code: "DATABASE_REJECTED",
    })
  })
  it("matches executable canonical JSON and SHA for bounded REPO plans across nested ordering, UTF-8 and numbers", async () => {
    const tokens = ['quote"slash/\\', "\b\f\n\r\t", "é中😀", "\u2028\u2029", "\u0001\u001f", "a"]
    let seed = 81217
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    const hashes = new Map<string, string>()
    for (let i = 0; i < 180; i++) {
      const plan = ScanExecutionPlanSchema.parse({
        ...buildScanExecutionPlan({
          targetType: "REPO",
          mode: i % 3 === 0 ? "STANDARD" : "SAFE",
          source: { revision: (i % 2 ? "a" : "b").repeat(40) },
        }),
        capabilities: [tokens[random() % tokens.length], tokens[random() % tokens.length]],
        limits: {
          maxBudgetUsd: [0, 0.0001, 1.2, 1.2345][i % 4],
          maxDurationMs: 60000,
          maxEngineMs: 48000,
          scannerReserveMs: 12000,
        },
      })
      // Reorder every object's keys independently; arrays retain identity.
      const reorder = (v: unknown): unknown =>
        Array.isArray(v)
          ? v.map(reorder)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v)
                  .sort(() => (random() % 2 ? -1 : 1))
                  .map(([k, x]) => [k, reorder(x)])
              )
            : v
      const serialized = JSON.stringify(reorder(plan))
      const r = (
        await runtime.query(
          "SELECT app.scan_preparation_plan_json($1::jsonb) canonical,encode(public.digest(convert_to(app.scan_preparation_plan_json($1::jsonb),'UTF8'),'sha256'),'hex') hash",
          [serialized]
        )
      ).rows[0]
      const canonical = canonicalizeScanExecutionPlan(plan),
        expected = computeScanExecutionPlanHash(plan)
      expect(r).toEqual({ canonical, hash: expected })
      if (hashes.has(expected)) expect(hashes.get(expected)).toBe(canonical)
      hashes.set(expected, canonical)
    }
    // Native null, boolean and empty/nested arrays/objects are equivalent too;
    // these values are deliberately unavailable in the accepted plan shape.
    const value = { z: null, a: [true, false, [], {}, tokens], n: 1.2345 }
    expect(
      (
        await runtime.query("SELECT app.scan_preparation_plan_json($1::jsonb) canonical", [
          JSON.stringify(value),
        ])
      ).rows[0].canonical
    ).toBe('{"a":[true,false,[],{},' + JSON.stringify(tokens) + '],"n":1.2345,"z":null}')
  })
  it("rejects source mutation through raw SQL despite unchanged stored hash and digest", async () => {
    const f = await preparationFixture(owner),
      c = await lockedClient(f)
    await owner.query(
      'UPDATE "Scan" SET "executionPlan"=jsonb_set("executionPlan",\'{source,revision}\',to_jsonb($2::text)) WHERE id=$1',
      [f.scanId, "f".repeat(40)]
    )
    try {
      await c.query("SELECT app.acquire_scan_preparation_gate()")
      await expect(insertPreparationAttempt(c, f)).rejects.toThrow(
        "hash-mismatched preparation plan"
      )
    } finally {
      await c.query("ROLLBACK")
      c.release()
    }
  })
  it("accepts a still-current delegated operation with separate immutable provenance", async () => {
    const f = await preparationFixture(owner, 1, "delegated-current", undefined, true)
    expect((await broker.prepare(preparationInput(f))).kind).toBe("committed")
  })
  it("rejects reachable SET ROLE writers even with NOINHERIT", async () => {
    await owner.query(
      "GRANT dispatch_authority_runtime TO dispatch_prepare_broker WITH INHERIT FALSE,SET TRUE"
    )
    try {
      await expect(runtime.query("SELECT app.require_scan_preparation_role()")).rejects.toThrow(
        "writer privileges"
      )
    } finally {
      await owner.query("REVOKE dispatch_authority_runtime FROM dispatch_prepare_broker")
    }
  })
  it("rejects persisted scan-bound upload IDs and numeric shapes outside the canonical subset", async () => {
    const attachmentId = "real-upload-" + Date.now(),
      f = await preparationFixture(owner, 1, "persisted-upload", {
        targetType: "REPO",
        mode: "SAFE",
        attachmentIds: [attachmentId],
      })
    await owner.query(
      'INSERT INTO "ScanAttachment"(id,"workspaceId",filename,"mediaType","byteLength",checksum,"storageUri","encryptionKeyRef",status,"createdById","createdAt") VALUES($1,$2,\'fixture.txt\',\'text/plain\',1,$3,$4,\'fixture-key\',\'ACTIVE\',$5,CURRENT_TIMESTAMP)',
      [attachmentId, f.workspaceId, "a".repeat(64), `fixture-private:${attachmentId}`, f.userId]
    )
    await expect(broker.prepare(preparationInput(f))).rejects.toMatchObject({
      code: "DATABASE_REJECTED",
    })
    const unsupported = await preparationFixture(owner, 0.00001, "numeric-unavailable")
    await expect(broker.prepare(preparationInput(unsupported))).rejects.toMatchObject({
      code: "DATABASE_REJECTED",
    })
  })
  it("covers every accepted four-place budget decimal and safe integer boundary", async () => {
    const budgets = Array.from({ length: 50001 }, (_, i) => i / 10000)
    const serialized = JSON.stringify(budgets)
    const r = (
      await runtime.query("SELECT app.scan_preparation_plan_json($1::jsonb) canonical", [
        serialized,
      ])
    ).rows[0]
    expect(r.canonical).toBe(serialized)
    const ints = [0, 1, 1199999, 1200000, 1380000, 2400000, 2700000]
    expect(
      (
        await runtime.query("SELECT app.scan_preparation_plan_json($1::jsonb) canonical", [
          JSON.stringify(ints),
        ])
      ).rows[0].canonical
    ).toBe(JSON.stringify(ints))
  }, 20000)
  it("rejects an owner session masquerading as the broker with SET ROLE", async () => {
    const c = await owner.connect()
    try {
      await c.query("BEGIN")
      await c.query("SET LOCAL ROLE dispatch_prepare_broker")
      await expect(c.query("SELECT app.require_scan_preparation_role()")).rejects.toThrow(
        "direct restricted login"
      )
    } finally {
      await c.query("ROLLBACK")
      c.release()
    }
  })
  it("retains the additive closed catalog: private definers, invoker guards and twenty-nine enabled triggers", async () => {
    const names = [
      "scan_preparation_context",
      "require_scan_preparation_role",
      "scan_preparation_gate_held",
      "scan_preparation_writer_gate",
      "scan_preparation_account_writer_gate",
      "acquire_scan_preparation_gate",
      "scan_preparation_plan_json",
      "check_scan_preparation_authority",
      "scan_checked_preparation_insert",
      "scan_checked_prepare_command",
      "scan_checked_preparation_bundle",
      "reject_checked_preparation_start",
      "scan_checked_preparation_physical",
      "scan_checked_preparation_operation",
      "reject_checked_preparation_consumption",
    ]
    const rows = (
      await owner.query(
        "SELECT p.proname,p.prosecdef,p.proretset,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname=ANY($1::text[])",
        [names]
      )
    ).rows
    expect(rows).toHaveLength(15)
    for (const row of rows) {
      expect(row.prosecdef).toBe(
        [
          "scan_preparation_context",
          "scan_preparation_writer_gate",
          "scan_preparation_account_writer_gate",
        ].includes(row.proname)
      )
      expect(row.proretset).toBe(
        ["scan_preparation_context", "check_scan_preparation_authority"].includes(row.proname)
      )
      expect(row.proconfig).toEqual([expect.stringMatching(/^search_path=pg_catalog/)])
    }
    const triggers = (
      await owner.query(
        "SELECT t.tgname,t.tgtype,t.tgenabled,t.tgdeferrable,t.tginitdeferred FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname=ANY($1::text[])",
        [names]
      )
    ).rows
    expect(triggers).toHaveLength(29)
    for (const t of triggers) {
      expect(t.tgenabled).toBe("O")
      expect(t.tgdeferrable).toBe(t.tgname === "scan_checked_preparation_bundle")
      expect(t.tginitdeferred).toBe(t.tgname === "scan_checked_preparation_bundle")
      // Statement triggers on the source-authority tables stay row-shaped only
      // where the bundle constraint needs per-row deferral.
      if (t.tgname === "scan_preparation_writer_gate") expect(t.tgtype).toBe(30)
      if (t.tgname === "scan_preparation_account_writer_gate") expect(t.tgtype).toBe(30)
      if (t.tgname === "scan_checked_preparation_bundle") expect(t.tgtype).toBe(5)
    }
    expect(
      (
        await owner.query(
          "SELECT has_function_privilege('dispatch_authority_runtime','app.scan_preparation_context(text)','EXECUTE') allowed"
        )
      ).rows[0].allowed
    ).toBe(false)
  })
  it("rejects raw checked insertion while admission capacity is still waiting", async () => {
    const f = await preparationFixture(owner, 1, "raw-waiting", undefined, false, "WAITING"),
      c = await lockedClient(f)
    try {
      await c.query("SELECT app.acquire_scan_preparation_gate()")
      await expect(insertPreparationAttempt(c, f)).rejects.toThrow("reserved admission capacity")
    } finally {
      await c.query("ROLLBACK")
      c.release()
    }
  })
  it("rejects reachable unreviewed definers in any namespace even before USAGE is granted", async () => {
    await owner.query(
      "CREATE SCHEMA fence_unreviewed;CREATE FUNCTION fence_unreviewed.denied() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT pg_sleep(0)';REVOKE ALL ON FUNCTION fence_unreviewed.denied() FROM PUBLIC;GRANT EXECUTE ON FUNCTION fence_unreviewed.denied() TO dispatch_prepare_broker"
    )
    try {
      await expect(runtime.query("SELECT app.require_scan_preparation_role()")).rejects.toThrow(
        "unreviewed definer"
      )
    } finally {
      await owner.query(
        "REVOKE EXECUTE ON FUNCTION fence_unreviewed.denied() FROM dispatch_prepare_broker"
      )
    }
  })
  it.each(["revokedAt"])(
    "fences restricted grant %s writes in both ordering directions",
    async (field) => {
      const revoker = new pg.Pool({
        connectionString: process.env.DISPATCH_AUTHORITY_REVOKER_DATABASE_URL,
        max: 2,
      })
      const statement = `UPDATE "ScanWorkerInstanceGrant" SET "${field}"=clock_timestamp() AT TIME ZONE 'UTC' WHERE id=$1`
      const first = await preparationFixture(owner, 1, "authority-race"),
        c = await lockedClient(first),
        w = await revoker.connect()
      try {
        await w.query("BEGIN")
        await w.query(statement, [first.grantId])
        expect(
          (await c.query("SELECT app.acquire_scan_preparation_gate() acquired")).rows[0].acquired
        ).toBe(false)
        await w.query("COMMIT")
        await c.query("SELECT app.acquire_scan_preparation_gate()")
        await expect(insertPreparationAttempt(c, first)).rejects.toMatchObject({ code: "23514" })
      } finally {
        await c.query("ROLLBACK")
        await w.query("ROLLBACK")
        c.release()
        w.release()
      }
      expect(
        (
          await owner.query(
            'SELECT count(*)::int n FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
            [first.operationId]
          )
        ).rows[0].n
      ).toBe(0)
      const second = await preparationFixture(owner, 1, "authority-race"),
        p = await lockedClient(second),
        r = await revoker.connect()
      try {
        await p.query("SELECT app.acquire_scan_preparation_gate()")
        const attemptId = await insertPreparationAttempt(p, second)
        await r.query("BEGIN")
        const revoke = r.query(statement, [second.grantId])
        await waitingForLock("ShareLock")
        await sealPreparationBundle(p, second, attemptId)
        await p.query("COMMIT")
        await revoke
        await r.query("COMMIT")
        expect(
          (
            await owner.query('SELECT state FROM "ScanDispatchOperation" WHERE "operationId"=$1', [
              second.operationId,
            ])
          ).rows[0].state
        ).toBe("PREPARING")
        await expect(broker.prepare(preparationInput(second))).rejects.toMatchObject({
          code: "WORKER_GRANT_INVALID",
        })
      } finally {
        await p.query("ROLLBACK")
        await r.query("ROLLBACK")
        p.release()
        r.release()
        await revoker.end()
      }
    }
  )
  it.each(["ScanWorkerInstanceGrant", "ScanAuthorityEpoch"])(
    "rejects same-transaction %s mutation after sealing and SET CONSTRAINTS",
    async (table) => {
      const f = await preparationFixture(owner, 1, "authority-race"),
        c = await lockedClient(f)
      try {
        await c.query("SELECT app.acquire_scan_preparation_gate()")
        const attemptId = await insertPreparationAttempt(c, f)
        await sealPreparationBundle(c, f, attemptId)
        await c.query("SET CONSTRAINTS ALL IMMEDIATE")
        await expect(
          c.query(`UPDATE "${table}" SET "updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`, [
            table === "ScanWorkerInstanceGrant" ? f.grantId : f.epochId,
          ])
        ).rejects.toThrow("writes are forbidden")
      } finally {
        await c.query("ROLLBACK")
        c.release()
      }
      const privileges = (
        await owner.query(
          "SELECT has_table_privilege('dispatch_authority_revoker','public.\"ScanWorkerInstanceGrant\"','UPDATE') broad_grant,has_table_privilege('dispatch_authority_revoker','public.\"ScanAuthorityEpoch\"','UPDATE') broad_epoch,has_column_privilege('dispatch_prepare_broker','public.\"ScanWorkerInstanceGrant\"','revokedAt','UPDATE') broker_revoke,has_column_privilege('dispatch_prepare_broker','public.\"ScanAuthorityEpoch\"','isOpen','UPDATE') broker_close"
        )
      ).rows[0]
      expect(privileges).toEqual({
        broad_grant: false,
        broad_epoch: false,
        broker_revoke: false,
        broker_close: false,
      })
    }
  )
  it.each(["scopes", "allowedProfiles", "allowedOperations", "allowedTargetIds"])(
    "rejects NULL elements in delegated %s through restricted SQL",
    async (field) => {
      for (const withAllowed of [false, true]) {
        const f = await preparationFixture(owner, 1, "null-delegated", undefined, true),
          w = await writerTransaction(f)
        const allowed =
          field === "scopes"
            ? "lyrashield.write"
            : field === "allowedProfiles"
              ? "safe"
              : field === "allowedOperations"
                ? "scan.create"
                : f.targetId
        try {
          await w.query(
            `UPDATE agent_connections SET "${field}"=$2::text[] WHERE "workspaceId"=$1`,
            [f.workspaceId, withAllowed ? [allowed, null] : [null]]
          )
          await w.query("COMMIT")
        } finally {
          await w.query("ROLLBACK")
          w.release()
        }
        await expect(broker.prepare(preparationInput(f))).rejects.toMatchObject({
          code: "DATABASE_REJECTED",
        })
        const c = await lockedClient(f)
        try {
          await c.query("SELECT app.acquire_scan_preparation_gate()")
          await expect(insertPreparationAttempt(c, f)).rejects.toThrow(
            "delegation revoked or unproven"
          )
        } finally {
          await c.query("ROLLBACK")
          c.release()
        }
      }
    }
  )
  it("matches canonical lowercase delegated profile normalization", async () => {
    const f = await preparationFixture(owner, 1, "lowercase", undefined, true),
      w = await writerTransaction(f)
    try {
      await w.query(
        'UPDATE agent_connections SET "allowedProfiles"=ARRAY[\'safe\'] WHERE "workspaceId"=$1',
        [f.workspaceId]
      )
      await w.query("COMMIT")
    } finally {
      await w.query("ROLLBACK")
      w.release()
    }
    expect((await broker.prepare(preparationInput(f))).kind).toBe("committed")
  })
  it.each(["LIVE_DELAY", "LIVE_STALL"])(
    "bounds %s after a true post-COMMIT liveness result",
    async (mode) => {
      const f = await preparationFixture(owner),
        input = preparationInput(f)
      input.expiresAt = (
        await owner.query(
          "SELECT (clock_timestamp() AT TIME ZONE 'UTC')+interval '3 seconds' expiry"
        )
      ).rows[0].expiry
      const arm = process.env[mode + "_ARM_PATH"]!,
        marker = process.env[mode + "_MARKER_PATH"]!
      await writeFile(arm, "armed", { flag: "wx", mode: 0o600 })
      const start = performance.now(),
        result = await broker.prepare(input)
      expect(performance.now() - start).toBeLessThan(3800)
      expect(result).toEqual({
        kind: "unknown",
        operationId: f.operationId,
        reasonCode: "PREPARATION_ACKNOWLEDGEMENT_DEADLINE",
      })
      expect(await readFile(marker, "utf8")).toBe("live=true\n")
      await expect(broker.status(f.operationId)).resolves.toMatchObject({
        kind: "available",
        state: "PREPARING",
        preparationEligibility: "EXPIRED",
        attemptId: expect.any(String),
      })
      expect(
        (
          await owner.query(
            'SELECT count(*)::int n FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
            [f.operationId]
          )
        ).rows[0].n
      ).toBe(1)
    },
    6000
  )
  it("checks elapsed time after the pg release callback and final caller continuation", async () => {
    const f = await preparationFixture(owner),
      input = preparationInput(f)
    input.expiresAt = (
      await owner.query("SELECT (clock_timestamp() AT TIME ZONE 'UTC')+interval '1 second' expiry")
    ).rows[0].expiry
    const original = pg.Pool.prototype.emit
    let armed = true
    const spy = vi.spyOn(pg.Pool.prototype, "emit").mockImplementation(function (event, ...args) {
      if (
        event === "release" &&
        armed &&
        (args[1] as { user?: string })?.user === "dispatch_prepare_broker"
      ) {
        armed = false
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100)
      }
      return original.call(this, event, ...args)
    })
    try {
      expect(await broker.prepare(input)).toEqual({
        kind: "unknown",
        operationId: f.operationId,
        reasonCode: "PREPARATION_ACKNOWLEDGEMENT_DEADLINE",
      })
    } finally {
      spy.mockRestore()
    }
    expect(armed).toBe(false)
    await expect(broker.status(f.operationId)).resolves.toMatchObject({
      kind: "available",
      state: "PREPARING",
      preparationEligibility: "EXPIRED",
    })
  })
  it("retains immutable grant expiry and rejects expiry before raw insertion or bundle completion", async () => {
    const expiry = (
      await owner.query("SELECT (clock_timestamp() AT TIME ZONE 'UTC')+interval '2 seconds' expiry")
    ).rows[0].expiry
    const f = await preparationFixture(owner, 1, "authority-race", undefined, false, "RESERVED", {
        grantExpiresAt: expiry,
      }),
      c = await lockedClient(f)
    await owner.query(
      "SELECT pg_sleep(greatest(extract(epoch FROM ($1::timestamp AT TIME ZONE 'UTC'-clock_timestamp())),0)+0.01)",
      [expiry]
    )
    try {
      await c.query("SELECT app.acquire_scan_preparation_gate()")
      await expect(insertPreparationAttempt(c, f, { expiresAt: expiry })).rejects.toThrow("expired")
    } finally {
      await c.query("ROLLBACK")
      c.release()
    }
    const secondExpiry = (
      await owner.query("SELECT (clock_timestamp() AT TIME ZONE 'UTC')+interval '2 seconds' expiry")
    ).rows[0].expiry
    const second = await preparationFixture(
        owner,
        1,
        "authority-race",
        undefined,
        false,
        "RESERVED",
        { grantExpiresAt: secondExpiry }
      ),
      p = await lockedClient(second)
    try {
      await p.query("SELECT app.acquire_scan_preparation_gate()")
      const attemptId = await insertPreparationAttempt(p, second, { expiresAt: secondExpiry })
      await owner.query(
        "SELECT pg_sleep(greatest(extract(epoch FROM ($1::timestamp AT TIME ZONE 'UTC'-clock_timestamp())),0)+0.01)",
        [secondExpiry]
      )
      await expect(sealPreparationBundle(p, second, attemptId)).rejects.toThrow(
        "original live transaction bundle"
      )
    } finally {
      await p.query("ROLLBACK")
      p.release()
    }
    expect(
      (
        await owner.query(
          'SELECT count(*)::int n FROM "ScanDispatchAttempt" WHERE "operationId" IN ($1,$2)',
          [f.operationId, second.operationId]
        )
      ).rows[0].n
    ).toBe(0)
    expect(
      (
        await owner.query(
          "SELECT has_column_privilege('dispatch_authority_revoker','public.\"ScanWorkerInstanceGrant\"','expiresAt','UPDATE') expiry_mutation"
        )
      ).rows[0].expiry_mutation
    ).toBe(false)
  })

  it("scopes an unresolved invocation guard to its own workspace", async () => {
    const f = await preparationFixture(owner)
    const other = `${f.workspaceId}-other`
    const input = preparationInput(f)
    const prepared = await broker.prepare(input)
    if (prepared.kind !== "committed") throw new Error("fixture did not commit")
    // Owner stages the exact state a lost acknowledgement leaves: a guard with
    // no resolution. The guard's own invariants do not apply to this fixture.
    const seed = await owner.connect()
    try {
      await seed.query("BEGIN")
      await seed.query(
        'ALTER TABLE "ScanExecutionInvocationGuard" DISABLE TRIGGER scan_execution_invocation_guard'
      )
      await seed.query(
        `INSERT INTO "ScanExecutionInvocationGuard"(id,"operationId","attemptId","scanId","workspaceId","authorityEpochId",phase,"authorityChecksum","actionChecksum","bindingInputJson")
         VALUES ($1,$2,$3,$4,$5,$6,'START',repeat('a',64),repeat('b',64),'{}')`,
        [`${f.operationId}-stuck`, f.operationId, prepared.attemptId, f.scanId, other, f.epochId]
      )
      await seed.query(
        'ALTER TABLE "ScanExecutionInvocationGuard" ENABLE TRIGGER scan_execution_invocation_guard'
      )
      await seed.query("COMMIT")
    } catch (error) {
      await seed.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      seed.release()
    }

    // Without a workspace context the write cannot be attributed, so the global
    // check still applies and the fence stays closed.
    const global = await owner.query("SELECT app.scan_execution_invocation_pending() AS pending")
    expect(global.rows[0].pending).toBe(true)

    // The unresolved guard's own workspace still fails closed.
    const blocked = await owner.connect()
    try {
      await blocked.query("BEGIN")
      await blocked.query("SELECT set_config('app.current_workspace_id',$1,true)", [other])
      const pending = await blocked.query(
        "SELECT app.scan_execution_invocation_pending() AS pending"
      )
      expect(pending.rows[0].pending).toBe(true)
      await expect(
        blocked.query('UPDATE "Scan" SET "updatedAt"=clock_timestamp() WHERE id=$1', [f.scanId])
      ).rejects.toThrow(/revocation pending/)
      await blocked.query("ROLLBACK")
    } catch (error) {
      await blocked.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      blocked.release()
    }

    // Another workspace is unaffected: the guard is scoped, not global, so the
    // source-authority write path stays open for every other tenant.
    const clear = await owner.connect()
    try {
      await clear.query("BEGIN")
      await clear.query("SELECT set_config('app.current_workspace_id',$1,true)", [f.workspaceId])
      const pending = await clear.query("SELECT app.scan_execution_invocation_pending() AS pending")
      expect(pending.rows[0].pending).toBe(false)
      await clear.query('UPDATE "Scan" SET "updatedAt"=clock_timestamp() WHERE id=$1', [f.scanId])
      await clear.query("COMMIT")
    } catch (error) {
      await clear.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      clear.release()
    }
    // Disposable owner cleanup only; the staged guard must not leak into the
    // context-less fixtures other cases in this file seed.
    await owner.query('TRUNCATE "ScanExecutionInvocationGuard" CASCADE')
  })

  it("keeps money settlement writable under SERIALIZABLE while source authority needs READ COMMITTED", async () => {
    const f = await preparationFixture(owner)
    const policyId = (await owner.query('SELECT "policyId" FROM "Scan" WHERE id=$1', [f.scanId]))
      .rows[0]?.policyId
    // Source authority rejects a non-READ COMMITTED write.
    const source = await owner.connect()
    try {
      await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ")
      await expect(
        source.query('UPDATE "Policy" SET "maxBudgetUsd"=1 WHERE id=$1', [policyId])
      ).rejects.toThrow(/READ COMMITTED/)
    } finally {
      await source.query("ROLLBACK")
      source.release()
    }
    // Account-owned money and ledger rows settle under SERIALIZABLE, so the
    // account gate must not carry the READ COMMITTED rule.
    const money = await owner.connect()
    const account = (await owner.query('SELECT "accountId" FROM "BillingAccount" LIMIT 1')).rows[0]
      ?.accountId
    if (!account) return
    try {
      await money.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
      await money.query(
        'UPDATE "BillingAccount" SET "updatedAt"=clock_timestamp() WHERE "accountId"=$1',
        [account]
      )
      await money.query(
        'UPDATE "ScanCapacityReservation" SET "updatedAt"=clock_timestamp() WHERE "accountId"=$1',
        [account]
      )
      await money.query("COMMIT")
    } catch (error) {
      await money.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      money.release()
    }
  })
})
