import { withScanDispatchWorkerCredential } from "./scan-dispatch-worker-assignment"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import pg from "pg"
import { canonicalJson, sha256Hex, type AuthorityAction } from "@lyrashield/runtime-control"
import { createScanSandboxToolIntentProducer } from "./scan-sandbox-tool-intent"
import {
  startSandboxToolExec,
  sandboxToolExecChecksum,
} from "../../../apps/supervisor/src/sandbox-tool-exec"
import { createSandboxToolStartAcknowledger } from "../../../apps/supervisor/src/sandbox-tool-start-ack"
import { SandboxToolJournal } from "../../../apps/supervisor/src/sandbox-tool-journal"
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest"
import { authenticateRetainedSupervisorAuthoritySource } from "./scan-supervisor-authority-source-verifier"
import {
  createDisposableSupervisorCommandHistoryReader,
  SupervisorCommandHistoryReader,
} from "./scan-supervisor-command-history-reader"
import { readRetainedSupervisorCommand } from "./scan-supervisor-command-history"
import { readRetainedSupervisorAuthoritySource } from "./scan-supervisor-authority-source"
import { createScanDispatchAuthorityBroker } from "./scan-dispatch-authority-broker"
import {
  preparationFixture,
  preparationInput,
  applyPreparationFixtureMigration,
  installPreparationFixtureRole,
} from "../scripts/tests/scan-preparation-fixture"
import { queueFixtureWorker } from "../scripts/tests/queue-outbox-fixture"
import {
  installNativeMirrorRole,
  nativePreparationJournal,
} from "../scripts/tests/supervisor-native-fixture"
import { installReceiptRole, receiptJournal } from "../scripts/tests/supervisor-receipt-fixture"
import { installLifecycleFixtureRoles } from "../scripts/tests/scan-lifecycle-fixture"
import { LifecycleFixtureExecutor } from "../scripts/tests/scan-lifecycle-executor"
import { createBrokerService } from "../../../apps/broker/src/service"
import { createSupervisorHandler } from "../../../apps/supervisor/src/http"
import { createInstalledDispatchCommandReader } from "../../../apps/supervisor/src/dispatch-command"

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
  receiptUrl: string,
  mirrorUrl: string,
  prepare: ReturnType<typeof createScanDispatchAuthorityBroker>
let lifecycleRoles: Awaited<ReturnType<typeof installLifecycleFixtureRoles>>
const queue = queueFixtureWorker()
const cleanup: (() => Promise<unknown>)[] = []
async function fixture(hold = true) {
  const f = await preparationFixture(owner, 0, "receipt")
  expect((await prepare.prepare(preparationInput(f))).kind).toBe("committed")
  const journal = await receiptJournal(owner, f, receiptUrl, hold)
  cleanup.push(journal.cleanup)
  const broker = createScanDispatchAuthorityBroker({
    connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
    receiptAuthority: journal.authority,
  })
  cleanup.push(() => broker.close())
  return { f, journal, broker }
}
function nativeFixtureResources() {
  return {
    schema: "lyrashield-executor-resources/1" as const,
    hostPolicyChecksum: "a".repeat(64),
    imageDigest: `sha256:${"a".repeat(64)}`,
    uid: 1000 as const,
    gid: 1000 as const,
    workspaceRoot: "/workspace" as const,
    workdir: "/workspace" as const,
    source: null,
    attachments: null,
    relay: null,
    egress: {
      grantId: "egress-fixture",
      policyPath: "/run/lyrashield-egress/policy.json" as const,
      policyChecksum: "a".repeat(64),
      authorizedHosts: [],
      relayRequired: false,
      readOnly: true as const,
    },
    scratchRoot: "/workspace/.attachments-scratch" as const,
    isolation: {
      networkPolicyChecksum: "a".repeat(64),
      seccompPolicyChecksum: "a".repeat(64),
      appArmorProfile: "fixture-profile",
      dropCapabilities: "ALL" as const,
      noNewPrivileges: true as const,
      readOnlyRoot: true as const,
      shmMb: 512 as const,
    },
    stagingRecordChecksum: "a".repeat(64),
    issuerKeyHash: "b".repeat(64),
  }
}
async function counts(operationId: string) {
  return (
    await owner.query(
      `SELECT
  (SELECT count(*)::int FROM "ScanSupervisorJournalRecord" WHERE "operationId"=$1) records,
  (SELECT count(*)::int FROM "ScanSupervisorReceipt" WHERE "operationId"=$1) receipts,
  (SELECT count(*)::int FROM "ScanPhysicalExecutionTransition" WHERE "operationId"=$1) transitions,
  (SELECT count(*)::int FROM "ScanDispatchStart" WHERE "operationId"=$1) starts`,
      [operationId]
    )
  ).rows[0]
}
describe.skipIf(!enabled)("authenticated broker receipt consumption", { timeout: 30000 }, () => {
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    owner.on("error", () => {})
    await queue.open()
    await applyPreparationFixtureMigration(owner)
    await installPreparationFixtureRole(owner)
    receiptUrl = await installReceiptRole(owner)
    mirrorUrl = await installNativeMirrorRole(owner)
    lifecycleRoles = await installLifecycleFixtureRoles(owner)
    prepare = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
      compilePreparation: () => ({
        executors: [
          {
            key: "scanner",
            spec: {
              kind: "container",
              image: `fixture@sha256:${"a".repeat(64)}`,
              argv: [],
              env: {},
              network: "fixture",
              cpus: 1,
              memoryMb: 64,
              pidsLimit: 16,
              readOnly: true,
            },
          },
        ],
      }),
    })
  }, 30000)
  afterAll(async () => {
    for (const close of cleanup.reverse()) await close()
    await prepare?.close()
    await owner?.end()
    await queue.close()
  })
  it("defaults closed and runtime/preparation credentials cannot write signed source", async () => {
    await expect(prepare.consumeSupervisorReceipts("missing-operation")).rejects.toMatchObject({
      code: "SUPERVISOR_CONSUMER_NOT_INSTALLED",
    })
    for (const url of [
      process.env.RLS_RUNTIME_DATABASE_URL,
      process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL,
    ]) {
      const denied = new pg.Pool({ connectionString: url })
      try {
        await expect(
          denied.query('SELECT * FROM "ScanSupervisorJournalRecord"')
        ).rejects.toMatchObject({ code: "42501" })
      } finally {
        await denied.end()
      }
    }
  })
  it("retains a positive receipt but keeps checked controller actions closed", async () => {
    const { f, broker } = await fixture(false)
    const result = await broker.consumeSupervisorReceipts(f.operationId)
    expect(result).toMatchObject({ dispositions: [{ status: "HELD", observedStatus: "PREPARED" }] })
    expect(await counts(f.operationId)).toEqual({
      records: 2,
      receipts: 2,
      transitions: 0,
      starts: 0,
    })
    const state = (
      await owner.query('SELECT state::text FROM "ScanPhysicalExecution" WHERE "operationId"=$1', [
        f.operationId,
      ])
    ).rows[0].state
    expect(state).toBe("RESERVED")
  })
  it("applies only the final authenticated recovery hold and deduplicates replay", async () => {
    const { f, broker } = await fixture()
    expect(await broker.consumeSupervisorReceipts(f.operationId)).toMatchObject({
      dispositions: [{ status: "UNKNOWN" }],
    })
    expect(await counts(f.operationId)).toEqual({
      records: 3,
      receipts: 3,
      transitions: 1,
      starts: 0,
    })
    expect(await broker.consumeSupervisorReceipts(f.operationId)).toMatchObject({
      dispositions: [{ status: "UNKNOWN" }],
    })
    expect(await counts(f.operationId)).toEqual({
      records: 3,
      receipts: 3,
      transitions: 1,
      starts: 0,
    })
    const state = (
      await owner.query(
        `SELECT p.state::text physical,c.status::text command,o.state::text operation,r.state::text capacity FROM "ScanPhysicalExecution" p JOIN "ScanDispatchOutbox" c ON c."attemptId"=p."attemptId" JOIN "ScanDispatchOperation" o ON o."operationId"=p."operationId" JOIN "ScanCapacityReservation" r ON r."scanId"=o."scanId" WHERE p."operationId"=$1`,
        [f.operationId]
      )
    ).rows[0]
    expect(state).toEqual({
      physical: "UNKNOWN",
      command: "UNKNOWN",
      operation: "UNKNOWN",
      capacity: "RESERVED",
    })
  })
  it("never confirms a signed prefix when a later page is tampered", async () => {
    const { f, journal } = await fixture()
    const reader = journal.authority.readJournal
    const corrupted = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      receiptAuthority: {
        ...journal.authority,
        readJournal: async (cursor) => {
          const page = (await reader(cursor)) as { records: Array<{ signature: string }> }
          if (cursor.afterSequence === 2) {
            const changed = structuredClone(page)
            changed.records[0]!.signature = "a".repeat(64)
            return changed
          }
          return page
        },
      },
    })
    cleanup.push(() => corrupted.close())
    await expect(corrupted.consumeSupervisorReceipts(f.operationId)).rejects.toThrow()
    expect(await counts(f.operationId)).toEqual({
      records: 2,
      receipts: 0,
      transitions: 0,
      starts: 0,
    })
    expect(
      Number(
        (
          await owner.query(
            'SELECT "confirmedSequence" FROM "ScanSupervisorJournalStream" WHERE id=$1',
            [journal.authority.streamId]
          )
        ).rows[0].confirmedSequence
      )
    ).toBe(0)
  })
  it("rejects uninstalled authority and a correctly signed but unapproved command", async () => {
    const { f, journal } = await fixture()
    const missing = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      receiptAuthority: { ...journal.authority, streamId: "missing-stream" },
    })
    cleanup.push(() => missing.close())
    await expect(missing.consumeSupervisorReceipts(f.operationId)).rejects.toMatchObject({
      code: "SUPERVISOR_STREAM_NOT_INSTALLED",
    })
    expect(await counts(f.operationId)).toEqual({
      records: 0,
      receipts: 0,
      transitions: 0,
      starts: 0,
    })
    const other = await preparationFixture(owner, 0, "forged-receipt")
    expect((await prepare.prepare(preparationInput(other))).kind).toBe("committed")
    const forged = await receiptJournal(owner, other, receiptUrl, true, true)
    cleanup.push(forged.cleanup)
    const reject = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      receiptAuthority: forged.authority,
    })
    cleanup.push(() => reject.close())
    await expect(reject.consumeSupervisorReceipts(other.operationId)).rejects.toMatchObject({
      code: "SUPERVISOR_COMMAND_IDENTITY_MISMATCH",
    })
    expect(await counts(other.operationId)).toEqual({
      records: 3,
      receipts: 0,
      transitions: 0,
      starts: 0,
    })
  })
  it("keeps a recovery hold sticky across a later authenticated positive terminal", async () => {
    const f = await preparationFixture(owner, 0, "sticky-receipt")
    expect((await prepare.prepare(preparationInput(f))).kind).toBe("committed")
    const journal = await receiptJournal(owner, f, receiptUrl, true, false, true)
    cleanup.push(journal.cleanup)
    const broker = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      receiptAuthority: journal.authority,
    })
    cleanup.push(() => broker.close())
    expect(await broker.consumeSupervisorReceipts(f.operationId)).toMatchObject({
      dispositions: [{ status: "UNKNOWN", observedStatus: "UNKNOWN" }],
    })
    expect(await counts(f.operationId)).toEqual({
      records: 4,
      receipts: 4,
      transitions: 1,
      starts: 0,
    })
    expect(
      (
        await owner.query(
          'SELECT state::text FROM "ScanPhysicalExecution" WHERE "operationId"=$1',
          [f.operationId]
        )
      ).rows[0].state
    ).toBe("UNKNOWN")
  })
  it("retains one quarantine when its final projection COMMIT acknowledgement is lost", async () => {
    const { f, journal } = await fixture()
    const read = journal.authority.readJournal
    let armed = false
    const broker = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      receiptAuthority: {
        ...journal.authority,
        readJournal: async (cursor) => {
          const page = (await read(cursor)) as { records: unknown[] }
          if (!armed && page.records.length === 0) {
            if (!process.env.FAULT_ARM_PATH) throw new Error("COMMIT relay unavailable")
            await writeFile(process.env.FAULT_ARM_PATH + ".projection", "armed")
            armed = true
          }
          return page
        },
      },
    })
    cleanup.push(() => broker.close())
    await expect(broker.consumeSupervisorReceipts(f.operationId)).rejects.toMatchObject({
      code: "SUPERVISOR_RECEIPT_COMMIT_UNKNOWN",
    })
    expect(await counts(f.operationId)).toEqual({
      records: 3,
      receipts: 3,
      transitions: 1,
      starts: 0,
    })
    expect(await broker.consumeSupervisorReceipts(f.operationId)).toMatchObject({
      dispositions: [{ status: "UNKNOWN" }],
    })
    expect(await counts(f.operationId)).toEqual({
      records: 3,
      receipts: 3,
      transitions: 1,
      starts: 0,
    })
  })
  it("holds confirmed receipt publication behind the native invocation fence", async () => {
    const { f, journal, broker } = await fixture()
    const native = await owner.connect()
    try {
      await native.query("BEGIN")
      await native.query("SELECT pg_advisory_xact_lock(1819234670,1)")
      await expect(broker.consumeSupervisorReceipts(f.operationId)).rejects.toMatchObject({
        code: "SUPERVISOR_AUTHORITY_BUSY",
      })
      expect(await counts(f.operationId)).toEqual({
        records: 3,
        receipts: 0,
        transitions: 0,
        starts: 0,
      })
      expect(
        Number(
          (
            await owner.query(
              'SELECT "confirmedSequence" FROM "ScanSupervisorJournalStream" WHERE id=$1',
              [journal.authority.streamId]
            )
          ).rows[0].confirmedSequence
        )
      ).toBe(0)
      await native.query("COMMIT")
      expect(await broker.consumeSupervisorReceipts(f.operationId)).toMatchObject({
        dispositions: [{ status: "UNKNOWN" }],
      })
    } finally {
      await native.query("ROLLBACK")
      native.release()
    }
  })
  it("reads exact predecessor bytes only under the same gate and workspace", async () => {
    const { f, journal, broker } = await fixture(false)
    await broker.consumeSupervisorReceipts(f.operationId)
    const native = await owner.connect()
    const input = {
      operationId: f.operationId,
      attemptId: journal.attemptId,
      commandId: journal.commandId,
      authorityEpochId: f.epochId,
      supervisorInstanceId: f.instanceId,
      receiptHash: journal.records[1]!.payload.payload.hash,
    }
    try {
      await native.query("BEGIN")
      await native.query("SELECT set_config('app.current_workspace_id',$1,true)", [f.workspaceId])
      await expect(readRetainedSupervisorAuthoritySource(native, input)).rejects.toMatchObject({
        code: "SUPERVISOR_AUTHORITY_SOURCE_UNAVAILABLE",
      })
      await native.query("SELECT pg_advisory_xact_lock(1819234670,1)")
      const retained = await readRetainedSupervisorAuthoritySource(native, input)
      expect(retained.original.hash).toBe(input.receiptHash)
      expect(retained.command.commandId).toBe(journal.commandId)
      expect(retained.uncertain).toBe(false)
      const authenticated = await authenticateRetainedSupervisorAuthoritySource(
        retained,
        journal.authority,
        native
      )
      expect(authenticated.original.hash).toBe(input.receiptHash)
      const historyInput = {
        streamId: journal.authority.streamId,
        authorityEpochId: f.epochId,
        commandId: journal.commandId,
        attemptId: journal.attemptId,
        requestHash: retained.commandInputChecksum,
      }
      const history = await readRetainedSupervisorCommand(native, historyInput, journal.authority)
      expect(history.originalInputJson).toBe(canonicalJson(journal.records[0]!.payload.payload))
      expect(history.command.commandId).toBe(journal.commandId)
      expect(history.observedStatus).toBe("PREPARED")
      const reader = createDisposableSupervisorCommandHistoryReader(journal.authority)
      cleanup.push(() => reader.close())
      expect(SupervisorCommandHistoryReader.isInstalled(reader)).toBe(false)
      expect(SupervisorCommandHistoryReader.isInstalled({ withRead: () => history })).toBe(false)
      await expect(reader.withRead(historyInput, async () => null)).rejects.toMatchObject({
        code: "SUPERVISOR_AUTHORITY_BUSY",
      })
      await expect(
        readRetainedSupervisorCommand(
          native,
          { ...historyInput, commandId: "missing-command" },
          journal.authority
        )
      ).rejects.toMatchObject({ code: "SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE" })
      await expect(
        readRetainedSupervisorCommand(
          native,
          { ...historyInput, requestHash: "f".repeat(64) },
          journal.authority
        )
      ).rejects.toMatchObject({ code: "SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE" })
      await expect(
        authenticateRetainedSupervisorAuthoritySource(
          {
            ...retained,
            wrapperInputJson: retained.wrapperInputJson.replace(
              '"signature":"',
              '"signature":"bad'
            ),
          },
          journal.authority,
          native
        )
      ).rejects.toThrow()
      await native.query("SELECT set_config('app.current_workspace_id','foreign-workspace',true)")
      await expect(readRetainedSupervisorAuthoritySource(native, input)).rejects.toMatchObject({
        code: "SUPERVISOR_AUTHORITY_SOURCE_UNAVAILABLE",
      })
    } finally {
      await native.query("ROLLBACK")
      native.release()
    }
  })
  it("holds exact history scope and native gate through the witness callback", async () => {
    const { f, journal, broker } = await fixture(false)
    await broker.consumeSupervisorReceipts(f.operationId)
    const checksum = (
      await owner.query('SELECT "commandInputChecksum" FROM "ScanDispatchOutbox" WHERE id=$1', [
        journal.commandId,
      ])
    ).rows[0].commandInputChecksum
    const reader = createDisposableSupervisorCommandHistoryReader(journal.authority)
    cleanup.push(() => reader.close())
    const input = {
      streamId: journal.authority.streamId,
      authorityEpochId: f.epochId,
      commandId: journal.commandId,
      attemptId: journal.attemptId,
      requestHash: checksum,
    }
    await reader.withRead(input, async (history, assertActive) => {
      assertActive()
      expect(history.command.commandId).toBe(journal.commandId)
      expect(history.observedStatus).toBe("PREPARED")
      const other = await owner.connect()
      try {
        expect(
          (await other.query("SELECT pg_try_advisory_xact_lock(1819234670,1) AS held")).rows[0].held
        ).toBe(false)
      } finally {
        other.release()
      }
    })
    expect(
      (await owner.query("SELECT pg_try_advisory_xact_lock(1819234670,1) AS held")).rows[0].held
    ).toBe(true)
    await expect(
      reader.withRead({ ...input, commandId: "missing-command" }, async () => null)
    ).rejects.toMatchObject({ code: "SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE" })
  })
  it("consumes genuine fenced metadata preparation through independently acknowledged PostgreSQL and durable file mirrors", async () => {
    const f = await preparationFixture(owner, 0, "native-receipt")
    expect((await prepare.prepare(preparationInput(f))).kind).toBe("committed")
    const source = await nativePreparationJournal(owner, f, receiptUrl, mirrorUrl)
    cleanup.push(source.cleanup)
    const result = await source.service.execute(source.command)
    expect(result.status).toBe("PREPARED")
    const broker = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      receiptAuthority: source.authority,
    })
    cleanup.push(() => broker.close())
    expect(await broker.consumeSupervisorReceipts(f.operationId)).toMatchObject({
      dispositions: [{ status: "PREPARED" }],
    })
    expect((await broker.status(f.operationId)).state).toBe("PREPARED")
    const state = (
      await owner.query(
        `SELECT p.state,c.status,(SELECT count(*) FROM "ScanExecutionInvocationResolution" r JOIN "ScanExecutionInvocationGuard" g ON g.id=r."guardId" WHERE g."operationId"=$1) resolutions
      FROM "ScanPhysicalExecution" p JOIN "ScanDispatchOutbox" c ON c."operationId"=p."operationId" AND c."attemptId"=p."attemptId" WHERE p."operationId"=$1`,
        [f.operationId]
      )
    ).rows[0]
    expect(state).toEqual({ state: "PREPARING", status: "COMPLETED", resolutions: "1" })
    expect((await counts(f.operationId)).starts).toBe(0)
    expect(await broker.consumeSupervisorReceipts(f.operationId)).toMatchObject({
      dispositions: [{ status: "PREPARED" }],
    })
    expect((await counts(f.operationId)).transitions).toBe(1)
  })
  it("freezes one exact command per executor with one immutable unmetered decision", async () => {
    const f = await preparationFixture(owner, 0, "native-lifecycle")
    const resourceDescriptor = nativeFixtureResources()
    const preparation = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
      compilePreparation: () => ({
        executors: (["sandbox", "scanner"] as const).map((key) => ({
          key,
          spec: {
            kind: "container" as const,
            image: `fixture@sha256:${"a".repeat(64)}`,
            argv: [],
            env: {},
            network: "fixture",
            cpus: 1,
            memoryMb: 64,
            pidsLimit: 16,
            readOnly: true,
            resourceDescriptor,
          },
        })),
      }),
    })
    cleanup.push(() => preparation.close())
    // Earlier isolated cases retain their worker grants. This
    // worker path requires the real single-current-grant contract.
    await owner.query(
      'UPDATE "ScanWorkerInstanceGrant" SET "revokedAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP WHERE id<>$1 AND "revokedAt" IS NULL',
      [f.grantId]
    )
    const assigned = await owner.connect()
    try {
      await assigned.query("BEGIN")
      await assigned.query(
        "SELECT pg_advisory_xact_lock_shared(1819234670,1),set_config('app.current_workspace_id',$1,true)",
        [f.workspaceId]
      )
      await assigned.query(
        'INSERT INTO "ScanDispatchWorkerAssignment"("operationId","workspaceId","workerGrantId","authorityEpochId") VALUES($1,$2,$3,$4)',
        [f.operationId, f.workspaceId, f.grantId, f.epochId]
      )
      await assigned.query("COMMIT")
    } finally {
      assigned.release()
    }
    const prepared = await preparation.prepare(preparationInput(f))
    expect(prepared.kind).toBe("committed")
    const executor = new LifecycleFixtureExecutor()
    const source = await nativePreparationJournal(owner, f, receiptUrl, mirrorUrl, {
      executor,
      nativeUrl: lifecycleRoles.nativeUrl,
      proofUrl: lifecycleRoles.proofUrl,
    })
    cleanup.push(source.cleanup)
    expect((await source.service.execute(source.command)).status).toBe("PREPARED")
    const broker = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      lifecycleConnectionString: lifecycleRoles.stageUrl,
      preparationAuthority: "checked-intent-v1",
      receiptAuthority: source.authority,
    })
    cleanup.push(() => broker.close())
    await broker.consumeSupervisorReceipts(f.operationId)
    const input = {
      operationId: f.operationId,
      attemptId: source.command.attempt.attemptId,
      workerInstanceId: f.instanceId,
      workerGrantId: f.grantId,
      authorityEpochId: f.epochId,
    }
    const captured = await source.authority.readAttemptProof!({
      operationId: f.operationId,
      attemptId: input.attemptId,
      authorityEpochId: f.epochId,
      workspaceId: f.workspaceId,
      scanId: f.scanId,
      type: "START_UNMETERED",
      executorKey: "sandbox",
      commandId: `captured-${f.operationId}`,
      challenge: "b".repeat(64),
    })
    const proofActor = new pg.Pool({ connectionString: lifecycleRoles.proofUrl, max: 1 })
    try {
      await proofActor.query("SELECT app.require_scan_dispatch_proof_role()")
      for (const missing of ["purpose", "signature"] as const) {
        const invalid = { ...captured }
        Reflect.deleteProperty(invalid, missing)
        const proofJson = canonicalJson(invalid)
        await expect(
          proofActor.query("SELECT app.register_scan_dispatch_lifecycle_proof($1)", [proofJson])
        ).rejects.toMatchObject({ code: "23514" })
        expect(
          (
            await owner.query(
              'SELECT count(*)::int AS n FROM "ScanDispatchLifecycleProof" WHERE "workspaceId"=$1 AND "proofChecksum"=$2',
              [f.workspaceId, sha256Hex(proofJson)]
            )
          ).rows[0].n
        ).toBe(0)
      }
    } finally {
      await proofActor.end()
    }
    const stageActor = new pg.Pool({ connectionString: lifecycleRoles.stageUrl })
    try {
      const stage = await stageActor.connect()
      try {
        await stage.query("BEGIN")
        await stage.query(
          "SELECT pg_advisory_xact_lock_shared(1819234670,1),set_config('app.current_workspace_id',$1,true)",
          [f.workspaceId]
        )
        const tampered = { ...captured, signature: "0".repeat(128) }
        expect(
          (
            await stage.query(
              "SELECT app.scan_dispatch_lifecycle_proof_current($1,true) AS current",
              [canonicalJson(tampered)]
            )
          ).rows[0].current
        ).toBe(false)
        await expect(
          stage.query('SELECT * FROM "ScanDispatchLifecycleProof"')
        ).rejects.toMatchObject({ code: "42501" })
        await stage.query("ROLLBACK")
      } finally {
        stage.release()
      }
    } finally {
      await stageActor.end()
    }
    const dispatch = () =>
      withScanDispatchWorkerCredential(f.grantId, input, () => broker.dispatchPrepared(input))
    await expect(
      withScanDispatchWorkerCredential(f.grantId, input, () =>
        broker.dispatchPrepared({ ...input, executorKey: "scanner" } as typeof input)
      )
    ).rejects.toThrow()
    const first = await dispatch()
    expect(first.kind).toBe("committed")
    if (first.kind !== "committed") throw new Error("START failed")
    expect(await broker.startUnmetered({ ...input, executorKey: "sandbox" })).toMatchObject({
      commandId: first.commandId,
      startId: first.startId,
    })
    await expect(broker.startUnmetered({ ...input, executorKey: "scanner" })).rejects.toMatchObject(
      { code: "PREPARATION_AUTHORITY_BUSY" }
    )
    const readCommand = async (id: string) =>
      JSON.parse(
        (await owner.query('SELECT "commandInputJson" FROM "ScanDispatchOutbox" WHERE id=$1', [id]))
          .rows[0].commandInputJson
      )
    const firstResult = await source.service.execute(await readCommand(first.commandId))
    expect(
      firstResult.status,
      JSON.stringify({
        result: firstResult,
        failures: source.authorityFailures,
        creates: executor.createCalls,
      })
    ).toBe("STARTED")
    expect(await broker.consumeSupervisorReceipts(f.operationId)).toMatchObject({
      dispositions: expect.arrayContaining([
        { commandId: first.commandId, status: "STARTED", observedStatus: "STARTED" },
      ]),
    })
    const second = await dispatch()
    expect(second.kind).toBe("committed")
    if (second.kind !== "committed") throw new Error("second START failed")
    expect(second.startId).toBe(first.startId)
    expect(second.commandId).not.toBe(first.commandId)
    expect((await source.service.execute(await readCommand(second.commandId))).status).toBe(
      "STARTED"
    )
    await broker.consumeSupervisorReceipts(f.operationId)
    expect(executor.createCalls).toBe(2)
    expect(executor.startCalls).toBe(2)
    expect((await counts(f.operationId)).starts).toBe(1)
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM "ScanDispatchOutbox" WHERE "operationId"=$1 AND "commandType"=\'START_UNMETERED\' AND "authorityProofInputJson" IS NOT NULL',
          [f.operationId]
        )
      ).rows[0].n
    ).toBe(2)
    expect((await broker.status(f.operationId)).state).toBe("ACTIVE")
    const ownership = (await source.service.getAttempt(input.attemptId)).resources.find(
      (resource) => resource.executorKey === "sandbox"
    )
    if (!ownership) throw new Error("Started sandbox ownership is unavailable")
    const ownershipReceiptId = (
      await owner.query(
        'SELECT id FROM "ScanSupervisorReceipt" WHERE "operationId"=$1 AND "executorKey"=\'sandbox\' AND "eventType"=\'resource_started\'',
        [f.operationId]
      )
    ).rows[0].id
    const requestId = "1d5b3040-b775-43a0-a7fb-ac5965fb91fa"
    const request = {
      binding: {
        attemptId: input.attemptId,
        operationId: f.operationId,
        authorityEpochId: f.epochId,
        sandboxHandle: ownership.ownershipId,
      },
      requestId,
      commandId: requestId,
      argv: ["true"],
      cwd: "/workspace",
      user: "pentester" as const,
      timeoutSeconds: 1,
      maxOutputBytes: 1024,
    }
    const action: AuthorityAction = {
      phase: "SANDBOX_TOOL",
      operationId: f.operationId,
      attemptId: input.attemptId,
      scanId: f.scanId,
      workspaceId: f.workspaceId,
      authorityEpochId: f.epochId,
      authorityRevision: source.command.attempt.authorityRevision,
      executorKey: "sandbox",
      commandId: source.command.commandId,
      requestId,
      actionChecksum: "0".repeat(64),
      authorityChecksum: sha256Hex(
        canonicalJson({
          attempt: source.command.attempt,
          executors: source.command.executors,
          provider: source.command.provider ?? null,
        })
      ),
    }
    const scope = {
      action,
      supervisorInstanceId: `${f.instanceId}.tools`,
      workspaceRoot: "/workspace",
      ownership,
    }
    action.actionChecksum = sandboxToolExecChecksum(request, scope)
    const descriptor = {
      schema: "lyrashield-sandbox-tool-exec/1" as const,
      request,
      workspaceRoot: "/workspace",
      ownership,
    }
    const intents = createScanSandboxToolIntentProducer({
      connectionString: lifecycleRoles.nativeUrl,
      supervisorAuthority: source.authority,
    })
    cleanup.push(() => intents.close())
    expect((await intents.publish({ binding: action, descriptor, ownershipReceiptId })).kind).toBe(
      "committed"
    )
    await expect(
      intents.publish({
        binding: action,
        descriptor: { ...descriptor, request: { ...request, maxOutputBytes: 2048 } },
        ownershipReceiptId,
      })
    ).rejects.toThrow()
    const toolJournal = {
      load: async () => [],
      append: async () => undefined,
    } as unknown as SandboxToolJournal
    await startSandboxToolExec(request, scope, {
      fence: source.fence,
      journal: toolJournal,
      executor,
      native: { start: async () => ({ execId: "e".repeat(64) }) },
      acknowledgeStarted: createSandboxToolStartAcknowledger({
        journal: { append: (event) => source.service.recordSandboxNativeStart(event) },
        supervisorInstanceId: f.instanceId,
        prepareCommandInputChecksum: sha256Hex(canonicalJson(source.command)),
        inspect: async () => executor.inspect(ownership),
        assertActive: () => {
          if (!source.context.current()) throw new Error("tool native gate missing")
        },
      }),
    })
    await broker.consumeSupervisorReceipts(f.operationId)
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM "ScanExecutionInvocationResolution" r JOIN "ScanExecutionInvocationGuard" g ON g.id=r."guardId" WHERE g."operationId"=$1 AND g.phase=\'SANDBOX_TOOL\'',
          [f.operationId]
        )
      ).rows[0].n
    ).toBe(1)
    const lostRequest = {
      ...request,
      requestId: "f46c32c4-4f6c-4a41-969a-310462863d3a",
      commandId: "f46c32c4-4f6c-4a41-969a-310462863d3a",
    }
    const lostDescriptor = { ...descriptor, request: lostRequest }
    const lostAction = {
      ...action,
      requestId: lostRequest.requestId,
      actionChecksum: sha256Hex(canonicalJson(lostDescriptor)),
    }
    expect(
      (
        await intents.publish({
          binding: lostAction,
          descriptor: lostDescriptor,
          ownershipReceiptId,
        })
      ).kind
    ).toBe("committed")
    let lostGuardId = ""
    await expect(
      startSandboxToolExec(
        lostRequest,
        { ...scope, action: lostAction },
        {
          fence: source.fence,
          journal: toolJournal,
          executor,
          native: {
            start: async () => {
              lostGuardId = source.context.current()!.guardId
              throw new Error("root transport acknowledgement lost")
            },
          },
          acknowledgeStarted: async () => {
            throw new Error("Missing native ACK cannot be fabricated")
          },
        }
      )
    ).rejects.toThrow("acknowledgement lost")
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM "ScanExecutionInvocationGuard" g WHERE g."operationId"=$1 AND g.phase=\'SANDBOX_TOOL\' AND NOT EXISTS(SELECT 1 FROM "ScanExecutionInvocationResolution" r WHERE r."guardId"=g.id)',
          [f.operationId]
        )
      ).rows[0].n
    ).toBe(1)
    const stopped = await broker.stop({ ...input, reasonCode: "TEST_CLEANUP" })
    if (stopped.kind !== "committed") throw new Error("STOP outcome is unavailable")
    const removalBody = {
      schema: "lyrashield-native-tool-retirement/1",
      phase: "SANDBOX_TOOL",
      guardId: lostGuardId,
      nativeRequestId: lostGuardId,
      commandId: source.command.commandId,
      stopCommandId: stopped.commandId,
      operationId: f.operationId,
      attemptId: input.attemptId,
      authorityEpochId: f.epochId,
      requestId: lostRequest.requestId,
      actionChecksum: lostAction.actionChecksum,
      commandInputChecksum: sha256Hex(canonicalJson(source.command)),
      bindingInputJson: canonicalJson(lostAction),
      ownership,
      inspection: { state: "ABSENT" },
    }
    executor.toolRetirements = [
      { ...removalBody, receiptSha256: sha256Hex(canonicalJson(removalBody)) },
    ]
    expect((await source.service.execute(await readCommand(stopped.commandId))).status).toBe(
      "STOPPED"
    )
    await broker.consumeSupervisorReceipts(f.operationId)
    expect(
      (
        await owner.query(
          'SELECT "proofInputJson"::jsonb->>\'type\' AS type,"proofInputJson"::jsonb->>\'phase\' AS phase FROM "ScanExecutionInvocationResolution" WHERE "guardId"=$1',
          [lostGuardId]
        )
      ).rows[0]
    ).toEqual({ type: "native_invocation_retired", phase: "SANDBOX_TOOL" })
    await expect(broker.reconcile(input)).rejects.toThrow("Attempt proof is unavailable")
    await broker.consumeSupervisorReceipts(f.operationId)
    expect((await broker.status(f.operationId)).state).toBe("TERMINATED")
    expect(
      (
        await owner.query(
          'SELECT state::text FROM "ScanPhysicalExecution" WHERE "operationId"=$1',
          [f.operationId]
        )
      ).rows[0].state
    ).toBe("STOPPED")
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM "ScanDispatchReleaseReceipt" WHERE "operationId"=$1',
          [f.operationId]
        )
      ).rows[0].n
    ).toBe(1)
  }, 60000)
  it("delivers persisted broker commands and cleans only the original expired worker sandbox", async () => {
    const grantExpiresAt = new Date(Date.now() + 45000)
    const f = await preparationFixture(
      owner,
      0,
      "retained-grant-cleanup",
      undefined,
      false,
      "RESERVED",
      { grantExpiresAt }
    )
    await owner.query(
      'UPDATE "ScanWorkerInstanceGrant" SET "revokedAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP WHERE id<>$1 AND "revokedAt" IS NULL',
      [f.grantId]
    )
    const assigned = await owner.connect()
    try {
      await assigned.query("BEGIN")
      await assigned.query(
        "SELECT pg_advisory_xact_lock_shared(1819234670,1),set_config('app.current_workspace_id',$1,true)",
        [f.workspaceId]
      )
      await assigned.query(
        'INSERT INTO "ScanDispatchWorkerAssignment"("operationId","workspaceId","workerGrantId","authorityEpochId") VALUES($1,$2,$3,$4)',
        [f.operationId, f.workspaceId, f.grantId, f.epochId]
      )
      await assigned.query("COMMIT")
    } finally {
      assigned.release()
    }
    const compilePreparation = () => ({
      executors: (["sandbox", "scanner"] as const).map((key) => ({
        key,
        spec: {
          kind: "container" as const,
          image: `fixture@sha256:${"a".repeat(64)}`,
          argv: [],
          env: {},
          network: "fixture",
          cpus: 1,
          memoryMb: 64,
          pidsLimit: 16,
          readOnly: true,
          resourceDescriptor: nativeFixtureResources(),
        },
      })),
    })
    const preparation = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
      compilePreparation,
    })
    cleanup.push(() => preparation.close())
    const prepareRequest = { ...preparationInput(f), expiresAt: grantExpiresAt }
    const workerScope = {
      operationId: f.operationId,
      workerInstanceId: f.instanceId,
      workerGrantId: f.grantId,
      authorityEpochId: f.epochId,
    }
    expect(
      (
        await withScanDispatchWorkerCredential(f.grantId, workerScope, () =>
          preparation.prepare(prepareRequest)
        )
      ).kind
    ).toBe("committed")
    const executor = new LifecycleFixtureExecutor()
    const source = await nativePreparationJournal(owner, f, receiptUrl, mirrorUrl, {
      executor,
      nativeUrl: lifecycleRoles.nativeUrl,
      proofUrl: lifecycleRoles.proofUrl,
    })
    cleanup.push(source.cleanup)
    const receiver = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      receiptAuthority: source.authority,
    })
    cleanup.push(() => receiver.close())
    const selectorPool = new pg.Pool({ connectionString: lifecycleRoles.nativeUrl, max: 1 })
    cleanup.push(() => selectorPool.end())
    const socketRoot = await mkdtemp("/tmp/lyra-cleanup-")
    const socketPath = join(socketRoot, "source.sock")
    const controlToken = "control-fixture".repeat(4),
      scopedControlToken = "scoped-fixture".repeat(4)
    const server = createServer(
      createSupervisorHandler(source.service, {
        controlToken,
        scopedControlToken,
        admission: "open",
        attemptProofIssuer: source.authority.readAttemptProof,
        receiptConsumer: (operationId) => receiver.consumeSupervisorReceipts(operationId),
        persistedCommandReader: createInstalledDispatchCommandReader(selectorPool, f.epochId),
      })
    )
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, resolve)
    })
    cleanup.push(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
      await rm(socketRoot, { recursive: true, force: true })
    })
    const service = createBrokerService({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      lifecycleConnectionString: lifecycleRoles.stageUrl,
      transport: { kind: "unix", socketPath: join(socketRoot, "broker.sock") },
      controlToken,
      admission: "open",
      preparationAuthority: compilePreparation,
      receiptAuthority: {
        streamId: source.authority.streamId!,
        authorityEpochId: f.epochId,
        supervisorInstanceId: f.instanceId,
        originalKeyHash: source.authority.originalKeyHash!,
        wrapperKeyHash: source.authority.wrapperKeyHash!,
        attemptProofPublicKey: source.authority.attemptProofPublicKey!,
        controlToken: scopedControlToken,
        socketPath,
      },
    })
    cleanup.push(() => service.close())
    const input = {
      operationId: f.operationId,
      attemptId: source.command.attempt.attemptId,
      workerInstanceId: f.instanceId,
      workerGrantId: f.grantId,
      authorityEpochId: f.epochId,
    }
    const scoped = <T>(run: () => Promise<T>) =>
      withScanDispatchWorkerCredential(f.grantId, input, run)
    const deliveredPrepare = await scoped(() => service.prepare(prepareRequest))
    expect(deliveredPrepare.kind).toBe("committed")
    const started = await scoped(() => service.dispatchPrepared(input))
    expect(started.kind).toBe("committed")
    expect(executor.createCalls).toBe(1)
    expect(executor.startCalls).toBe(1)
    expect((await counts(f.operationId)).starts).toBe(1)
    expect((await service.status(f.operationId)).state).toBe("ACTIVE")
    // Fail only the status publication after both native and resource-start ACKs.
    // The supervisor must record UNKNOWN and retain the original cleanup authority.
    const actualAppend = source.journal.append.bind(source.journal)
    const failRunningPublication = vi
      .spyOn(source.journal, "append")
      .mockImplementation(async (event) => {
        if (event.type === "attempt_status" && event.status === "RUNNING")
          throw new Error("RUNNING publication unavailable after acknowledged native START")
        return actualAppend(event)
      })
    try {
      expect((await scoped(() => service.dispatchPrepared(input))).kind).toBe("unknown")
      await scoped(() => service.consume(f.operationId))
      expect((await service.status(f.operationId)).state).toBe("UNKNOWN")
    } finally {
      failRunningPublication.mockRestore()
    }
    expect(executor.createCalls).toBe(2)
    expect(executor.startCalls).toBe(2)
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM "ScanExecutionInvocationGuard" g WHERE g."operationId"=$1 AND NOT EXISTS(SELECT 1 FROM "ScanExecutionInvocationResolution" r WHERE r."guardId"=g.id)',
          [f.operationId]
        )
      ).rows[0].n
    ).toBe(0)
    await owner.query(
      'UPDATE "ScanWorkerInstanceGrant" SET "revokedAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1',
      [f.grantId]
    )
    await owner.query(
      'SELECT pg_sleep(greatest(0,extract(epoch FROM "expiresAt"-clock_timestamp())+0.05)) FROM "ScanWorkerInstanceGrant" WHERE id=$1',
      [f.grantId]
    )
    expect(
      (
        await owner.query(
          'SELECT "revokedAt" IS NOT NULL AND "expiresAt"<clock_timestamp() AS inactive FROM "ScanWorkerInstanceGrant" WHERE id=$1',
          [f.grantId]
        )
      ).rows[0].inactive
    ).toBe(true)
    await expect(
      scoped(() => service.startUnmetered({ ...input, executorKey: "sandbox" }))
    ).rejects.toMatchObject({ code: "PREPARATION_AUTHORITY_UNAVAILABLE" })
    expect(executor.createCalls).toBe(2)
    expect(executor.startCalls).toBe(2)
    const stopInput = { ...input, reasonCode: "RETAINED_GRANT_CLEANUP" }
    await expect(
      scoped(() => service.stop({ ...stopInput, workerGrantId: `${f.grantId}-other` }))
    ).rejects.toThrow()
    expect(executor.stopCalls).toBe(0)
    const stopped = await scoped(() => service.stop(stopInput))
    expect(stopped.kind).toBe("committed")
    expect(await scoped(() => service.stop(stopInput))).toEqual(stopped)
    await expect(scoped(() => service.consume(f.operationId))).resolves.toHaveProperty(
      "operationId",
      f.operationId
    )
    expect((await service.status(f.operationId)).state).toBe("UNKNOWN")
    await expect(scoped(() => service.reconcile(input))).resolves.toMatchObject({
      kind: "committed",
    })
    await expect(scoped(() => service.consume(f.operationId))).resolves.toHaveProperty(
      "operationId",
      f.operationId
    )
    expect(executor.stopCalls).toBe(2)
    expect((await service.status(f.operationId)).state).toBe("TERMINATED")
    expect(
      (
        await owner.query(
          'SELECT state::text FROM "ScanPhysicalExecution" WHERE "operationId"=$1',
          [f.operationId]
        )
      ).rows[0].state
    ).toBe("STOPPED")
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM "ScanDispatchReleaseReceipt" WHERE "operationId"=$1',
          [f.operationId]
        )
      ).rows[0].n
    ).toBe(1)
  }, 90000)
  it("preserves the operation after a committed staging acknowledgement is lost", async () => {
    const { f, broker } = await fixture()
    if (!process.env.FAULT_ARM_PATH) throw new Error("COMMIT relay unavailable")
    await writeFile(process.env.FAULT_ARM_PATH, "armed")
    await expect(broker.consumeSupervisorReceipts(f.operationId)).rejects.toMatchObject({
      code: "SUPERVISOR_RECEIPT_COMMIT_UNKNOWN",
    })
    expect((await counts(f.operationId)).starts).toBe(0)
    expect(await broker.consumeSupervisorReceipts(f.operationId)).toMatchObject({
      dispositions: [{ status: "UNKNOWN" }],
    })
    expect(await counts(f.operationId)).toEqual({
      records: 3,
      receipts: 3,
      transitions: 1,
      starts: 0,
    })
  })
  it("never freezes or invokes paid work after the billing-stage COMMIT acknowledgement is lost", async () => {
    if (!process.env.FAULT_ARM_PATH || !process.env.RLS_RUNTIME_DATABASE_URL)
      throw new Error("COMMIT relay unavailable")
    const f = await preparationFixture(owner, 1, "native-paid-stage", { mode: "STANDARD" })
    const preparation = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
      compilePreparation: () => ({
        executors: [
          {
            key: "sandbox",
            spec: {
              kind: "container",
              image: `fixture@sha256:${"a".repeat(64)}`,
              argv: [],
              env: {},
              network: "fixture",
              cpus: 1,
              memoryMb: 64,
              pidsLimit: 16,
              readOnly: true,
              grantEnvName: "LLM_API_KEY",
            },
          },
        ],
        provider: {
          providerId: "fixture",
          maxRequests: 1,
          costReservationMicros: 0,
          maxReservedCostMicros: 0,
        },
      }),
    })
    cleanup.push(() => preparation.close())
    expect((await preparation.prepare(preparationInput(f))).kind).toBe("committed")
    const executor = new LifecycleFixtureExecutor()
    const source = await nativePreparationJournal(owner, f, receiptUrl, mirrorUrl, {
      executor,
      nativeUrl: lifecycleRoles.nativeUrl,
      proofUrl: lifecycleRoles.proofUrl,
    })
    cleanup.push(source.cleanup)
    expect((await source.service.execute(source.command)).status).toBe("PREPARED")
    const stageUrl = new URL(lifecycleRoles.stageUrl)
    stageUrl.port = new URL(process.env.RLS_RUNTIME_DATABASE_URL).port
    let proofCalls = 0
    const readProof = source.authority.readAttemptProof!
    const checked = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      lifecycleConnectionString: lifecycleRoles.stageUrl,
      preparationAuthority: "checked-intent-v1",
      receiptAuthority: source.authority,
    })
    cleanup.push(() => checked.close())
    await checked.consumeSupervisorReceipts(f.operationId)
    await owner.query(
      'UPDATE "ScanCapacityReservation" SET "runtimeLimitMs"=30000 WHERE "scanId"=$1',
      [f.scanId]
    )
    await expect(
      checked.startPaid({
        operationId: f.operationId,
        attemptId: source.command.attempt.attemptId,
        workerInstanceId: f.instanceId,
        workerGrantId: f.grantId,
        authorityEpochId: f.epochId,
        executorKey: "sandbox",
      })
    ).rejects.toMatchObject({ code: "CAPACITY_NOT_READY" })
    expect((await counts(f.operationId)).starts).toBe(0)
    await owner.query(
      'UPDATE "ScanCapacityReservation" SET "runtimeLimitMs"=60000 WHERE "scanId"=$1',
      [f.scanId]
    )
    const broker = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      lifecycleConnectionString: stageUrl.toString(),
      preparationAuthority: "checked-intent-v1",
      receiptAuthority: {
        ...source.authority,
        readAttemptProof: async (input) => {
          const proof = await readProof(input)
          proofCalls++
          await writeFile(process.env.FAULT_ARM_PATH! + ".stage", "armed")
          return proof
        },
      },
    })
    cleanup.push(() => broker.close())
    await broker.consumeSupervisorReceipts(f.operationId)
    const result = await broker.startPaid({
      operationId: f.operationId,
      attemptId: source.command.attempt.attemptId,
      workerInstanceId: f.instanceId,
      workerGrantId: f.grantId,
      authorityEpochId: f.epochId,
      executorKey: "sandbox",
    })
    expect(result.kind).toBe("unknown")
    expect(proofCalls).toBe(1)
    expect(executor.createCalls).toBe(0)
    expect((await counts(f.operationId)).starts).toBe(1)
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM "ScanEvent" WHERE "scanId"=$1 AND stage=\'billable_boundary\'',
          [f.scanId]
        )
      ).rows[0].n
    ).toBe(1)
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM "ScanDispatchOutbox" WHERE "operationId"=$1 AND "commandType"=\'START_PAID\'',
          [f.operationId]
        )
      ).rows[0].n
    ).toBe(0)
  })
})
