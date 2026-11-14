import { writeFile } from "node:fs/promises"
import pg from "pg"
import { canonicalJson } from "@lyrashield/runtime-control"
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
describe.skipIf(!enabled)("authenticated broker receipt consumption", () => {
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    owner.on("error", () => {})
    await queue.open()
    await applyPreparationFixtureMigration(owner)
    await installPreparationFixtureRole(owner)
    receiptUrl = await installReceiptRole(owner)
    mirrorUrl = await installNativeMirrorRole(owner)
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
})
