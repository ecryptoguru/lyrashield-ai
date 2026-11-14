import { createHash, randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createScanDispatchAuthorityBroker } from "./scan-dispatch-authority-broker"
import { buildScanExecutionPlan, ScanExecutionPlanSchema } from "@lyrashield/types"
import { computeScanExecutionPlanHash } from "./scan-execution-plan"
import {
  applyPreparationFixtureMigration,
  installPreparationFixtureRole,
  legacyPreparationFixture,
  historicalPreparation,
} from "../scripts/tests/scan-preparation-fixture"
import { publishFixtureOutbox, queueFixtureWorker } from "../scripts/tests/queue-outbox-fixture"

// Hoisting runs this guard before imports can construct a client from ambient
// env. Bind the fixture's privileged DATABASE_URL role to its restricted
// authority broker role through the shared disposable-pair guard.
await vi.hoisted(async () => {
  const runtime = process.env.DISPATCH_AUTHORITY_DATABASE_URL
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1" || !runtime) return
  const { assertDisposableDatabasePair } =
    await import("../../../.github/scripts/vitest-database-env.mjs")
  assertDisposableDatabasePair({ ...process.env, RLS_RUNTIME_DATABASE_URL: runtime })
})

const enabled =
  process.env.SCAN_DISPATCH_AUTHORITY_POSTGRES_TEST === "1" &&
  process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1" &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DISPATCH_AUTHORITY_DATABASE_URL)

const ownerUrl = process.env.DATABASE_URL
const brokerUrl = process.env.DISPATCH_AUTHORITY_DATABASE_URL
const sharedEpochId = "authority-shared-open-epoch"
let owner: pg.Pool
let broker: ReturnType<typeof createScanDispatchAuthorityBroker>
let legacyBroker: ReturnType<typeof createScanDispatchAuthorityBroker>
const queueWorker = queueFixtureWorker()

type Fixture = {
  userId: string
  workspaceId: string
  targetId: string
  scanId: string
  operationId: string
  grantId: string
  epochId: string
  instanceId: string
}

async function createFixture(
  options: {
    reservationState?: "WAITING" | "RESERVED"
    maxBudgetUsd?: number
    fundedMinutes?: number
  } = {}
) {
  if (!owner) throw new Error("fixture database unavailable")
  const suffix = randomUUID()
  const fixture: Fixture = {
    userId: `authority-user-${suffix}`,
    workspaceId: `authority-workspace-${suffix}`,
    targetId: `authority-target-${suffix}`,
    scanId: `authority-scan-${suffix}`,
    operationId: `authority-operation-${suffix}`,
    grantId: `authority-grant-${suffix}`,
    epochId: sharedEpochId,
    instanceId: `authority-worker-${suffix}`,
  }
  const now = new Date()
  const plan = ScanExecutionPlanSchema.parse({
    ...buildScanExecutionPlan({
      targetType: "REPO",
      mode: "SAFE",
      source: { revision: "a".repeat(40) },
    }),
    limits: {
      maxBudgetUsd: options.maxBudgetUsd ?? 1,
      maxDurationMs: 60000,
      maxEngineMs: 48000,
      scannerReserveMs: 12000,
    },
    capabilities: ["engine", "sca"],
    attachmentIds: [],
  })
  await owner.query(
    'INSERT INTO "users" ("id", "name", "email", "createdAt", "updatedAt") VALUES ($1,$1,$2,$3,$3)',
    [fixture.userId, `${fixture.userId}@example.test`, now]
  )
  await owner.query(
    'INSERT INTO "Workspace" ("id","name","slug","mode","plan","deploymentType","retentionDays","telemetryEnabled","createdAt","updatedAt") VALUES ($1,$1,$1,\'VIBE\',\'FREE\',\'saas\',30,false,$2,$2)',
    [fixture.workspaceId, now]
  )
  await owner.query(
    `INSERT INTO "WorkspaceMember" (id,"workspaceId","userId",role,status,"createdAt","updatedAt") VALUES($1,$2,$3,'VIEWER','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [`member-${suffix}`, fixture.workspaceId, fixture.userId]
  )
  await owner.query(
    `INSERT INTO "BillingAccount" (id,"accountId",status,"currentPlan","createdAt","updatedAt") VALUES($1,$2,'active','PRO',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [`billing-${suffix}`, fixture.userId]
  )
  await owner.query(
    'INSERT INTO "Target" ("id","workspaceId","type","name","environment","status","createdAt","updatedAt") VALUES ($1,$2,\'REPO\',$1,\'STAGING\',\'active\',$3,$3)',
    [fixture.targetId, fixture.workspaceId, now]
  )
  await owner.query(
    `INSERT INTO "Scan" (
      "id","workspaceId","targetId","goal","mode","status","triggerType","accountingVersion",
      "determinismMode","executionPlan","executionPlanHash","createdById","sponsorAccountId",
      "createdAt","updatedAt"
    ) VALUES ($1,$2,$3,'TEST_APP','SAFE','QUEUED','manual',2,'default',$4::jsonb,$5,$6,$6,$7,$7)`,
    [
      fixture.scanId,
      fixture.workspaceId,
      fixture.targetId,
      JSON.stringify(plan),
      computeScanExecutionPlanHash(plan),
      fixture.userId,
      now,
    ]
  )
  const scope = await owner.query<{ requestDigest: string }>(
    'SELECT app.scan_dispatch_scope_digest($1) AS "requestDigest"',
    [fixture.scanId]
  )
  await owner.query(
    `INSERT INTO "ScanDispatchOperation"
      ("operationId","scanId","workspaceId","protocolVersion","requestDigest","state","createdAt","updatedAt")
     VALUES ($1,$2,$3,3,$4,'QUEUED',$5,$5)`,
    [fixture.operationId, fixture.scanId, fixture.workspaceId, scope.rows[0]!.requestDigest, now]
  )
  await publishFixtureOutbox(owner, fixture.scanId, fixture.operationId)
  await owner.query(
    'INSERT INTO "UserScanSlot" ("userId","scanId","workspaceId","createdAt") VALUES ($1,$2,$3,$4)',
    [fixture.userId, fixture.scanId, fixture.workspaceId, now]
  )
  await owner.query(
    `INSERT INTO "ScanCapacityReservation"
      ("scanId","accountId","workspaceId","userId","state","accountingVersion","multiplier",
       "poolMinutes","fundedMinutes","runtimeLimitMs","createdAt","updatedAt")
     VALUES ($1,$2,$3,$2,$4,2,1,2,$6,60000,$5,$5)`,
    [
      fixture.scanId,
      fixture.userId,
      fixture.workspaceId,
      options.reservationState ?? "RESERVED",
      now,
      options.fundedMinutes ?? 2,
    ]
  )
  await owner.query(
    `INSERT INTO "ScanWorkerInstanceGrant"
      ("id","authorityEpochId","instanceId","credentialHash","issuedAt","expiresAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + interval '1 hour',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [
      fixture.grantId,
      fixture.epochId,
      fixture.instanceId,
      `${"a".repeat(32)}${randomUUID().replaceAll("-", "")}`,
    ]
  )
  return fixture
}

async function markPrepared(
  fixture: Fixture,
  attemptId: string,
  commandId: string,
  options: { completePrepareCommand?: boolean } = {}
) {
  const complete = options.completePrepareCommand !== false
  const receipt1 = createHash("sha256").update(`${fixture.operationId}:1`).digest("hex")
  const receipt2 = createHash("sha256").update(`${receipt1}:2`).digest("hex")
  await owner.query(
    `INSERT INTO "ScanSupervisorReceipt" (
      "id","supervisorInstanceId","operationId","attemptId","authorityEpochId","commandId",
      "sequence","previousReceiptHash","receiptHash","signature","receiptType","executorKey",
      "outcome","evidenceDigest","observedAt","createdAt"
    ) VALUES ($1,$9,$2,$3,$4,$5,1,NULL,$6,$7,'COMMAND_ACCEPTED',NULL,
      'accepted',$8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [
      `receipt-1-${fixture.operationId}`,
      fixture.operationId,
      attemptId,
      fixture.epochId,
      commandId,
      receipt1,
      "s".repeat(64),
      "a".repeat(64),
      `supervisor-${fixture.operationId}`,
    ]
  )
  await owner.query(
    `INSERT INTO "ScanPhysicalExecutionTransition" (
      "id","attemptId","operationId","revision","fromState","toState","supervisorReceiptId","createdAt"
    ) VALUES ($1,$2,$3,2,'RESERVED','PREPARING',$4,CURRENT_TIMESTAMP)`,
    [
      `transition-1-${fixture.operationId}`,
      attemptId,
      fixture.operationId,
      `receipt-1-${fixture.operationId}`,
    ]
  )
  await owner.query(
    `UPDATE "ScanDispatchOutbox"
     SET "status"='ACCEPTED', "deliveredAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP
     WHERE "id"=$1`,
    [commandId]
  )
  if (complete) {
    await owner.query(
      `INSERT INTO "ScanSupervisorReceipt" (
        "id","supervisorInstanceId","operationId","attemptId","authorityEpochId","commandId",
        "sequence","previousReceiptHash","receiptHash","signature","receiptType","executorKey",
        "outcome","evidenceDigest","observedAt","createdAt"
      ) VALUES ($1,$10,$2,$3,$4,$5,2,$6,$7,$8,'PREPARE_COMPLETED',NULL,
        'completed',$9,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [
        `receipt-2-${fixture.operationId}`,
        fixture.operationId,
        attemptId,
        fixture.epochId,
        commandId,
        receipt1,
        receipt2,
        "s".repeat(64),
        "b".repeat(64),
        `supervisor-${fixture.operationId}`,
      ]
    )
    await owner.query(
      `UPDATE "ScanDispatchOutbox"
       SET "status"='COMPLETED', "updatedAt"=CURRENT_TIMESTAMP
       WHERE "id"=$1`,
      [commandId]
    )
  }
  await owner.query(
    `UPDATE "ScanDispatchOperation"
     SET "state"='PREPARED', "updatedAt"=CURRENT_TIMESTAMP
     WHERE "operationId"=$1`,
    [fixture.operationId]
  )
}

async function attemptExpiry(): Promise<Date> {
  return (
    await owner.query<{ expiresAt: Date }>(
      "SELECT CURRENT_TIMESTAMP + interval '10 minutes' AS \"expiresAt\""
    )
  ).rows[0]!.expiresAt
}

async function insertReceipt(
  fixture: Fixture,
  attemptId: string,
  commandId: string,
  receiptType: "COMMAND_ACCEPTED" | "EXECUTOR_EXITED" | "STOPPED" | "NEVER_DISPATCHED"
): Promise<{ receiptId: string; receiptHash: string }> {
  const head = await owner.query<{ receiptHash: string; sequence: number }>(
    `SELECT "receiptHash", "sequence" FROM "ScanSupervisorReceipt"
     WHERE "supervisorInstanceId"=$1 ORDER BY "sequence" DESC LIMIT 1`,
    [`supervisor-${fixture.operationId}`]
  )
  const sequence = head.rows[0]!.sequence + 1
  const previousReceiptHash = head.rows[0]!.receiptHash
  const receiptHash = createHash("sha256")
    .update(`${fixture.operationId}:${sequence}`)
    .digest("hex")
  const evidenceDigest = createHash("sha256")
    .update(`${fixture.operationId}:evidence:${sequence}`)
    .digest("hex")
  const receiptId = `receipt-${sequence}-${fixture.operationId}`
  await owner.query(
    `INSERT INTO "ScanSupervisorReceipt" (
      "id","supervisorInstanceId","operationId","attemptId","authorityEpochId","commandId",
      "sequence","previousReceiptHash","receiptHash","signature","receiptType","executorKey",
      "outcome","evidenceDigest","observedAt","createdAt"
    ) VALUES ($1,$9,$2,$3,$4,$5,$6,$7,$8,$10,$11,$12,
      'observed',$13,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [
      receiptId,
      fixture.operationId,
      attemptId,
      fixture.epochId,
      commandId,
      sequence,
      previousReceiptHash,
      receiptHash,
      `supervisor-${fixture.operationId}`,
      "s".repeat(64),
      receiptType,
      receiptType === "COMMAND_ACCEPTED" ? null : "executor-scan",
      evidenceDigest,
    ]
  )
  return { receiptId, receiptHash }
}

async function insertPhysicalTransition(
  fixture: Fixture,
  attemptId: string,
  revision: number,
  fromState: string,
  toState: string,
  receiptId: string
): Promise<void> {
  await owner.query(
    `INSERT INTO "ScanPhysicalExecutionTransition" (
      "id","attemptId","operationId","revision","fromState","toState",
      "supervisorReceiptId","createdAt"
    ) VALUES ($1,$2,$3,$4,$5::"ScanPhysicalExecutionState",$6::"ScanPhysicalExecutionState",$7,CURRENT_TIMESTAMP)`,
    [
      `transition-${revision}-${fixture.operationId}`,
      attemptId,
      fixture.operationId,
      revision,
      fromState,
      toState,
      receiptId,
    ]
  )
}

/** Drives a stopped operation to the durable terminal release receipt. */
async function advanceToRelease(
  fixture: Fixture,
  attemptId: string
): Promise<{ releaseId: string; releaseDigest: string }> {
  const stop = await broker.stop({
    operationId: fixture.operationId,
    attemptId,
    workerInstanceId: fixture.instanceId,
    workerGrantId: fixture.grantId,
    authorityEpochId: fixture.epochId,
    reasonCode: "USER_CANCELLED",
  })
  if (stop.kind !== "committed") throw new Error("fixture stop did not commit")

  const accept = await insertReceipt(fixture, attemptId, stop.commandId, "COMMAND_ACCEPTED")
  await insertPhysicalTransition(
    fixture,
    attemptId,
    3,
    "PREPARING",
    "STOP_REQUESTED",
    accept.receiptId
  )
  await owner.query(
    `UPDATE "ScanDispatchOutbox" SET "status"='ACCEPTED', "deliveredAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
    [stop.commandId]
  )
  const exited = await insertReceipt(fixture, attemptId, stop.commandId, "EXECUTOR_EXITED")
  await insertPhysicalTransition(
    fixture,
    attemptId,
    4,
    "STOP_REQUESTED",
    "CLEANUP_PENDING",
    exited.receiptId
  )
  const stopped = await insertReceipt(fixture, attemptId, stop.commandId, "STOPPED")
  await owner.query(
    `UPDATE "ScanDispatchOutbox" SET "status"='COMPLETED', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
    [stop.commandId]
  )
  await insertPhysicalTransition(
    fixture,
    attemptId,
    5,
    "CLEANUP_PENDING",
    "STOPPED",
    stopped.receiptId
  )
  await owner.query(
    `UPDATE "ScanDispatchOperation" SET "state"='TERMINATED', "terminalReason"='STOPPED_BY_RECEIPT', "updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1`,
    [fixture.operationId]
  )

  const releaseId = `release-${fixture.operationId}`
  const releaseDigest = createHash("sha256").update(`${fixture.operationId}:release`).digest("hex")
  await owner.query(
    `INSERT INTO "ScanDispatchReleaseReceipt" (
      "id","operationId","attemptId","authorityEpochId","physicalState",
      "supervisorReceiptId","releaseDigest","capacityDisposition","createdAt"
    ) VALUES ($1,$2,$3,$4,'STOPPED',$5,$6,'REVIEW_REQUIRED',CURRENT_TIMESTAMP)`,
    [releaseId, fixture.operationId, attemptId, fixture.epochId, stopped.receiptId, releaseDigest]
  )
  return { releaseId, releaseDigest }
}

describe.skipIf(!enabled)("scan dispatch authority broker", () => {
  beforeAll(async () => {
    if (!ownerUrl || !brokerUrl) throw new Error("fixture database URLs required")
    owner = new pg.Pool({ connectionString: ownerUrl, max: 2 })
    owner.on("error", () => undefined)
    owner.on("connect", (client) => {
      client.on("error", () => undefined)
    })
    await queueWorker.open()
    await applyPreparationFixtureMigration(owner)
    await installPreparationFixtureRole(owner)
    broker = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
    })
    legacyBroker = createScanDispatchAuthorityBroker({ connectionString: brokerUrl })
    const epoch = await owner.query(
      'SELECT "isOpen", "openKey", "openedAt", "closedAt" FROM "ScanAuthorityEpoch" WHERE id=$1',
      [sharedEpochId]
    )
    expect(epoch.rows).toEqual([
      { isOpen: true, openKey: "open", openedAt: expect.any(Date), closedAt: null },
    ])
  })

  afterAll(async () => {
    await queueWorker.close()
    await broker?.close()
    await legacyBroker?.close()
    await owner?.end()
  })

  it("commits preparation, the physical hold and PREPARE idempotently", async () => {
    const fixture = await createFixture()
    const expiresAt = (
      await owner.query<{ expiresAt: Date }>(
        "SELECT CURRENT_TIMESTAMP + interval '10 minutes' AS \"expiresAt\""
      )
    ).rows[0]!.expiresAt
    const grantCheck = await owner.query<{
      issued: boolean
      unexpired: boolean
      coversAttempt: boolean
      active: boolean
    }>(
      `SELECT ("issuedAt" <= CURRENT_TIMESTAMP) AS issued,
              ("expiresAt" > CURRENT_TIMESTAMP) AS "unexpired",
              ("expiresAt" >= ($2::timestamptz AT TIME ZONE 'UTC')) AS "coversAttempt",
              ("revokedAt" IS NULL) AS active
       FROM "ScanWorkerInstanceGrant"
       WHERE "id"=$1 AND "authorityEpochId"=$3 AND "instanceId"=$4`,
      [fixture.grantId, expiresAt, fixture.epochId, fixture.instanceId]
    )
    expect(grantCheck.rows[0]).toEqual({
      issued: true,
      unexpired: true,
      coversAttempt: true,
      active: true,
    })
    const result = await broker.prepare({
      operationId: fixture.operationId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
      expiresAt,
    })

    expect(result).toMatchObject({ kind: "committed", state: "PREPARING" })
    const counts = await owner.query<{
      attempts: string
      physical: string
      commands: string
      state: string
    }>(
      `SELECT
        (SELECT count(*) FROM "ScanDispatchAttempt" WHERE "operationId"=$1)::text AS attempts,
        (SELECT count(*) FROM "ScanPhysicalExecution" WHERE "operationId"=$1)::text AS physical,
        (SELECT count(*) FROM "ScanDispatchOutbox" WHERE "operationId"=$1)::text AS commands,
        (SELECT "state"::text FROM "ScanDispatchOperation" WHERE "operationId"=$1) AS state`,
      [fixture.operationId]
    )
    expect(counts.rows[0]).toEqual({
      attempts: "1",
      physical: "1",
      commands: "1",
      state: "PREPARING",
    })

    const replay = await broker.prepare({
      operationId: fixture.operationId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
      expiresAt,
    })
    expect(replay).toMatchObject({ kind: "committed", state: "PREPARING" })
    if (result.kind === "committed") {
      expect(replay).toMatchObject({ attemptId: result.attemptId })
    }
  })

  it("records capacity waiting without creating an attempt, then reuses the same operation", async () => {
    const fixture = await createFixture({ reservationState: "WAITING" })
    const expiresAt = (
      await owner.query<{ expiresAt: Date }>(
        "SELECT CURRENT_TIMESTAMP + interval '10 minutes' AS \"expiresAt\""
      )
    ).rows[0]!.expiresAt
    const waiting = await broker.prepare({
      operationId: fixture.operationId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
      expiresAt,
    })
    expect(waiting).toEqual({
      kind: "waiting",
      operationId: fixture.operationId,
      state: "WAITING_CAPACITY",
    })
    expect(
      (
        await owner.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
          [fixture.operationId]
        )
      ).rows[0]!.count
    ).toBe("0")

    await owner.query(
      'UPDATE "ScanCapacityReservation" SET "state"=\'RESERVED\', "updatedAt"=CURRENT_TIMESTAMP WHERE "scanId"=$1',
      [fixture.scanId]
    )
    const prepared = await broker.prepare({
      operationId: fixture.operationId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
      expiresAt,
    })
    expect(prepared).toMatchObject({ kind: "committed", state: "PREPARING" })
  })

  it("commits paid-start funding, the lifetime claim and START_PAID atomically", async () => {
    const fixture = await legacyPreparationFixture(owner)
    const prepared = await historicalPreparation(owner, fixture)
    if (prepared.kind !== "committed") throw new Error("fixture preparation did not commit")
    await markPrepared(fixture, prepared.attemptId, prepared.commandId)

    const started = await legacyBroker.startPaid({
      operationId: fixture.operationId,
      attemptId: prepared.attemptId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
    })
    expect(started).toMatchObject({ kind: "committed", state: "START_PENDING" })
    const state = await owner.query<{
      scanState: string
      reservationState: string
      boundaryClaims: string
      starts: string
      commands: string
    }>(
      `SELECT (SELECT "status"::text FROM "Scan" WHERE "id"=$1) AS "scanState",
              (SELECT "state" FROM "ScanCapacityReservation" WHERE "scanId"=$1) AS "reservationState",
              (SELECT count(*)::text FROM "ScanEvent" WHERE "scanId"=$1 AND "stage"='billable_boundary') AS "boundaryClaims",
              (SELECT count(*)::text FROM "ScanDispatchStart" WHERE "operationId"=$2) AS starts,
              (SELECT count(*)::text FROM "ScanDispatchOutbox" WHERE "operationId"=$2 AND "commandType"='START_PAID') AS commands`,
      [fixture.scanId, fixture.operationId]
    )
    expect(state.rows[0]).toEqual({
      scanState: "RUNNING",
      reservationState: "RUNNING",
      boundaryClaims: "1",
      starts: "1",
      commands: "1",
    })

    const replay = await legacyBroker.startPaid({
      operationId: fixture.operationId,
      attemptId: prepared.attemptId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
    })
    expect(replay).toEqual(started)
  })

  it("commits unmetered start without capacity or billing side effects", async () => {
    const fixture = await legacyPreparationFixture(owner, 0)
    const prepared = await historicalPreparation(owner, fixture)
    if (prepared.kind !== "committed") throw new Error("fixture preparation did not commit")
    await markPrepared(fixture, prepared.attemptId, prepared.commandId)

    const started = await legacyBroker.startUnmetered({
      operationId: fixture.operationId,
      attemptId: prepared.attemptId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
    })
    expect(started).toMatchObject({ kind: "committed", state: "START_PENDING" })
    const state = await owner.query<{
      scanState: string
      reservationState: string
      boundaryClaims: string
      starts: string
      commands: string
      kind: string
      maxBudget: string
      billableClaim: string | null
      providerGrant: string | null
    }>(
      `SELECT (SELECT "status"::text FROM "Scan" WHERE "id"=$1) AS "scanState",
              (SELECT "state" FROM "ScanCapacityReservation" WHERE "scanId"=$1) AS "reservationState",
              (SELECT count(*)::text FROM "ScanEvent" WHERE "scanId"=$1 AND "stage"='billable_boundary') AS "boundaryClaims",
              (SELECT count(*)::text FROM "ScanDispatchStart" WHERE "operationId"=$2) AS starts,
              (SELECT count(*)::text FROM "ScanDispatchOutbox" WHERE "operationId"=$2 AND "commandType"='START_UNMETERED') AS commands,
              (SELECT "kind"::text FROM "ScanDispatchStart" WHERE "operationId"=$2) AS kind,
              (SELECT "maxBudgetUsd"::text FROM "ScanDispatchStart" WHERE "operationId"=$2) AS "maxBudget",
              (SELECT "billableClaimEventId" FROM "ScanDispatchStart" WHERE "operationId"=$2) AS "billableClaim",
              (SELECT "providerGrantDigest" FROM "ScanDispatchStart" WHERE "operationId"=$2) AS "providerGrant"`,
      [fixture.scanId, fixture.operationId]
    )
    expect(state.rows[0]).toMatchObject({
      scanState: "RUNNING",
      reservationState: "RESERVED",
      boundaryClaims: "0",
      starts: "1",
      commands: "1",
      kind: "UNMETERED",
      billableClaim: null,
      providerGrant: null,
    })
    expect(Number(state.rows[0]!.maxBudget)).toBe(0)

    const replay = await legacyBroker.startUnmetered({
      operationId: fixture.operationId,
      attemptId: prepared.attemptId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
    })
    expect(replay).toEqual(started)
  })

  it("holds a persisted attempt at START after null→policy→null without replacing it", async () => {
    const fixture = await legacyPreparationFixture(owner, 0)
    const prepared = await historicalPreparation(owner, fixture)
    if (prepared.kind !== "committed") throw new Error("fixture preparation did not commit")
    await markPrepared(fixture, prepared.attemptId, prepared.commandId)
    const policyId = `start-policy-${randomUUID()}`
    await owner.query(
      'INSERT INTO "Policy"(id,"workspaceId",name,"blockedPaths","allowedDomains","updatedAt") VALUES($1,$2,$1,\'{}\',\'{}\',CURRENT_TIMESTAMP)',
      [policyId, fixture.workspaceId]
    )
    await owner.query('UPDATE "Scan" SET "policyId"=$2 WHERE id=$1', [fixture.scanId, policyId])
    await owner.query('UPDATE "Scan" SET "policyId"=NULL WHERE id=$1', [fixture.scanId])
    await expect(
      legacyBroker.startUnmetered({
        operationId: fixture.operationId,
        attemptId: prepared.attemptId,
        workerInstanceId: fixture.instanceId,
        workerGrantId: fixture.grantId,
        authorityEpochId: fixture.epochId,
      })
    ).rejects.toMatchObject({ code: "DATABASE_REJECTED" })
    expect(
      (
        await owner.query(
          'SELECT count(*)::int n FROM "ScanDispatchStart" WHERE "operationId"=$1',
          [fixture.operationId]
        )
      ).rows[0].n
    ).toBe(0)
    expect(
      (
        await owner.query('SELECT "attemptId" FROM "ScanDispatchAttempt" WHERE "operationId"=$1', [
          fixture.operationId,
        ])
      ).rows[0].attemptId
    ).toBe(prepared.attemptId)
  })

  it("rejects unmetered start when the attempt carries a positive budget", async () => {
    const fixture = await legacyPreparationFixture(owner)
    const prepared = await historicalPreparation(owner, fixture)
    if (prepared.kind !== "committed") throw new Error("fixture preparation did not commit")
    await markPrepared(fixture, prepared.attemptId, prepared.commandId)

    await expect(
      legacyBroker.startUnmetered({
        operationId: fixture.operationId,
        attemptId: prepared.attemptId,
        workerInstanceId: fixture.instanceId,
        workerGrantId: fixture.grantId,
        authorityEpochId: fixture.epochId,
      })
    ).rejects.toMatchObject({ code: "CAPACITY_NOT_READY" })
    expect(
      (
        await owner.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "ScanDispatchStart" WHERE "operationId"=$1',
          [fixture.operationId]
        )
      ).rows[0]!.count
    ).toBe("0")
  })

  it("rejects unmetered start when PREPARE is not complete", async () => {
    const fixture = await legacyPreparationFixture(owner, 0)
    const prepared = await historicalPreparation(owner, fixture)
    if (prepared.kind !== "committed") throw new Error("fixture preparation did not commit")
    // Reach the PREPARE-status check: the operation is PREPARED and physical
    // preparation is in flight, but the PREPARE outbox command is only
    // ACCEPTED, never COMPLETED.
    await markPrepared(fixture, prepared.attemptId, prepared.commandId, {
      completePrepareCommand: false,
    })

    await expect(
      legacyBroker.startUnmetered({
        operationId: fixture.operationId,
        attemptId: prepared.attemptId,
        workerInstanceId: fixture.instanceId,
        workerGrantId: fixture.grantId,
        authorityEpochId: fixture.epochId,
      })
    ).rejects.toMatchObject({
      code: "DISPATCH_OPERATION_STATE_INVALID",
      message: "PREPARE is not complete",
    })
    expect(
      (
        await owner.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "ScanDispatchStart" WHERE "operationId"=$1',
          [fixture.operationId]
        )
      ).rows[0]!.count
    ).toBe("0")
  })

  it("creates one durable STOP command without releasing capacity", async () => {
    const fixture = await createFixture()
    const expiresAt = (
      await owner.query<{ expiresAt: Date }>(
        "SELECT CURRENT_TIMESTAMP + interval '10 minutes' AS \"expiresAt\""
      )
    ).rows[0]!.expiresAt
    const prepared = await broker.prepare({
      operationId: fixture.operationId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
      expiresAt,
    })
    if (prepared.kind !== "committed") throw new Error("fixture preparation did not commit")

    const stop = await broker.stop({
      operationId: fixture.operationId,
      attemptId: prepared.attemptId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
      reasonCode: "USER_CANCELLED",
    })
    expect(stop).toMatchObject({ kind: "committed", state: "STOPPING" })
    const replay = await broker.stop({
      operationId: fixture.operationId,
      attemptId: prepared.attemptId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
      reasonCode: "USER_CANCELLED",
    })
    expect(replay).toEqual(stop)
    const state = await owner.query<{ stops: string; reservation: string; heldSlots: string }>(
      `SELECT (SELECT count(*)::text FROM "ScanDispatchOutbox" WHERE "operationId"=$1 AND "commandType"='STOP') AS stops,
              (SELECT "state" FROM "ScanCapacityReservation" WHERE "scanId"=$2) AS reservation,
              (SELECT count(*)::text FROM "UserScanSlot" WHERE "scanId"=$2) AS "heldSlots"`,
      [fixture.operationId, fixture.scanId]
    )
    expect(state.rows[0]).toEqual({ stops: "1", reservation: "RESERVED", heldSlots: "1" })
  })

  it("reconciles an unknown operation by command only and never creates another attempt", async () => {
    const fixture = await legacyPreparationFixture(owner)
    const prepared = await historicalPreparation(owner, fixture)
    if (prepared.kind !== "committed") throw new Error("fixture preparation did not commit")
    await owner.query(
      `UPDATE "ScanDispatchOperation"
       SET "state"='UNKNOWN', "terminalReason"='AMBIGUOUS_EFFECT', "updatedAt"=CURRENT_TIMESTAMP
       WHERE "operationId"=$1`,
      [fixture.operationId]
    )

    const reconciled = await broker.reconcile({
      operationId: fixture.operationId,
      attemptId: prepared.attemptId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
    })
    expect(reconciled).toMatchObject({ kind: "committed", state: "UNKNOWN" })
    const counts = await owner.query<{ attempts: string; reconcile: string; state: string }>(
      `SELECT (SELECT count(*)::text FROM "ScanDispatchAttempt" WHERE "operationId"=$1) AS attempts,
              (SELECT count(*)::text FROM "ScanDispatchOutbox" WHERE "operationId"=$1 AND "commandType"='RECONCILE') AS reconcile,
              (SELECT "state"::text FROM "ScanDispatchOperation" WHERE "operationId"=$1) AS state`,
      [fixture.operationId]
    )
    expect(counts.rows[0]).toEqual({ attempts: "1", reconcile: "1", state: "UNKNOWN" })
  })

  it("returns UNKNOWN on a lost COMMIT response and resolves replay by the same operation", async () => {
    const arm = process.env.FAULT_ARM_PATH
    const marker = process.env.FAULT_MARKER_PATH
    if (!arm || !marker) throw new Error("fault controls required")
    const fixture = await createFixture()
    const expiresAt = (
      await owner.query<{ expiresAt: Date }>(
        "SELECT CURRENT_TIMESTAMP + interval '10 minutes' AS \"expiresAt\""
      )
    ).rows[0]!.expiresAt
    await writeFile(arm, "arm", { flag: "wx", mode: 0o600 })

    // The one-shot fault targets preparation, never an unrelated owner COMMIT.
    const unrelated = await owner.connect()
    try {
      await unrelated.query("BEGIN")
      await unrelated.query("SELECT 1")
      await unrelated.query("COMMIT")
    } finally {
      unrelated.release()
    }

    const first = await broker.prepare({
      operationId: fixture.operationId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
      expiresAt,
    })
    expect(first).toEqual({
      kind: "unknown",
      operationId: fixture.operationId,
      reasonCode: "COMMIT_OUTCOME_UNKNOWN",
    })
    expect(await readFile(marker, "utf8")).toBe("dispatch-prepare-commit-response-dropped\n")
    const committed = await owner.query<{ attempts: string; state: string }>(
      `SELECT (SELECT count(*)::text FROM "ScanDispatchAttempt" WHERE "operationId"=$1) AS attempts,
              (SELECT "state"::text FROM "ScanDispatchOperation" WHERE "operationId"=$1) AS state`,
      [fixture.operationId]
    )
    expect(committed.rows[0]).toEqual({ attempts: "1", state: "PREPARING" })
    await expect(broker.status(fixture.operationId)).resolves.toMatchObject({
      kind: "available",
      state: "PREPARING",
    })
    const replay = await broker.prepare({
      operationId: fixture.operationId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
      expiresAt,
    })
    expect(replay).toMatchObject({ kind: "committed", state: "PREPARING" })
  }, 20_000)

  it("serializes concurrent preparation to one durable attempt and command", async () => {
    const fixture = await createFixture()
    const expiresAt = await attemptExpiry()
    const input = {
      operationId: fixture.operationId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
      expiresAt,
    }
    const [first, second] = await Promise.all([broker.prepare(input), broker.prepare(input)])
    expect(first).toMatchObject({ kind: "committed", state: "PREPARING" })
    expect(second).toMatchObject({ kind: "committed", state: "PREPARING" })
    if (first.kind === "committed" && second.kind === "committed") {
      expect(second.attemptId).toBe(first.attemptId)
      expect(second.commandId).toBe(first.commandId)
    }
    const counts = await owner.query<{
      attempts: string
      physical: string
      commands: string
      state: string
    }>(
      `SELECT
        (SELECT count(*) FROM "ScanDispatchAttempt" WHERE "operationId"=$1)::text AS attempts,
        (SELECT count(*) FROM "ScanPhysicalExecution" WHERE "operationId"=$1)::text AS physical,
        (SELECT count(*) FROM "ScanDispatchOutbox" WHERE "operationId"=$1)::text AS commands,
        (SELECT "state"::text FROM "ScanDispatchOperation" WHERE "operationId"=$1) AS state`,
      [fixture.operationId]
    )
    expect(counts.rows[0]).toEqual({
      attempts: "1",
      physical: "1",
      commands: "1",
      state: "PREPARING",
    })
  })

  it("rejects preparation against a revoked worker grant", async () => {
    const fixture = await createFixture()
    await owner.query(
      'UPDATE "ScanWorkerInstanceGrant" SET "revokedAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [fixture.grantId]
    )
    await expect(
      broker.prepare({
        operationId: fixture.operationId,
        workerInstanceId: fixture.instanceId,
        workerGrantId: fixture.grantId,
        authorityEpochId: fixture.epochId,
        expiresAt: await attemptExpiry(),
      })
    ).rejects.toMatchObject({ name: "ScanDispatchAuthorityError", code: "WORKER_GRANT_INVALID" })
    expect(
      (
        await owner.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
          [fixture.operationId]
        )
      ).rows[0]!.count
    ).toBe("0")
  })

  it("rejects preparation when the grant does not cover the attempt window", async () => {
    const fixture = await createFixture()
    await expect(
      broker.prepare({
        operationId: fixture.operationId,
        workerInstanceId: fixture.instanceId,
        workerGrantId: fixture.grantId,
        authorityEpochId: fixture.epochId,
        expiresAt: new Date(Date.now() + 2 * 3_600_000),
      })
    ).rejects.toMatchObject({ code: "WORKER_GRANT_INVALID" })
  })

  it("rejects authority issued from the closed baseline epoch", async () => {
    const fixture = await createFixture()
    await expect(
      broker.prepare({
        operationId: fixture.operationId,
        workerInstanceId: fixture.instanceId,
        workerGrantId: fixture.grantId,
        authorityEpochId: "scan-authority-baseline",
        expiresAt: await attemptExpiry(),
      })
    ).rejects.toMatchObject({ code: "AUTHORITY_EPOCH_CLOSED" })
  })

  it("rejects a replayed preparation under changed worker authority", async () => {
    const fixture = await createFixture()
    const expiresAt = await attemptExpiry()
    const prepared = await broker.prepare({
      operationId: fixture.operationId,
      workerInstanceId: fixture.instanceId,
      workerGrantId: fixture.grantId,
      authorityEpochId: fixture.epochId,
      expiresAt,
    })
    if (prepared.kind !== "committed") throw new Error("fixture preparation did not commit")

    const otherGrantId = `authority-grant-other-${fixture.operationId}`
    const otherInstanceId = `authority-worker-other-${fixture.operationId}`
    await owner.query(
      `INSERT INTO "ScanWorkerInstanceGrant"
        ("id","authorityEpochId","instanceId","credentialHash","issuedAt","expiresAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + interval '1 hour',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [
        otherGrantId,
        fixture.epochId,
        otherInstanceId,
        `${"b".repeat(32)}${randomUUID().replaceAll("-", "")}`,
      ]
    )
    await expect(
      broker.prepare({
        operationId: fixture.operationId,
        workerInstanceId: otherInstanceId,
        workerGrantId: otherGrantId,
        authorityEpochId: fixture.epochId,
        expiresAt,
      })
    ).rejects.toMatchObject({ code: "DISPATCH_REPLAY_CONFLICT" })
  })

  it("rejects stop and reconciliation issued under a different worker grant", async () => {
    const stopFixture = await createFixture()
    const stopPrepared = await broker.prepare({
      operationId: stopFixture.operationId,
      workerInstanceId: stopFixture.instanceId,
      workerGrantId: stopFixture.grantId,
      authorityEpochId: stopFixture.epochId,
      expiresAt: await attemptExpiry(),
    })
    if (stopPrepared.kind !== "committed") throw new Error("fixture preparation did not commit")

    const otherStopGrantId = `authority-grant-other-${stopFixture.operationId}`
    const otherStopInstanceId = `authority-worker-other-${stopFixture.operationId}`
    await owner.query(
      `INSERT INTO "ScanWorkerInstanceGrant"
        ("id","authorityEpochId","instanceId","credentialHash","issuedAt","expiresAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + interval '1 hour',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [
        otherStopGrantId,
        stopFixture.epochId,
        otherStopInstanceId,
        `${"b".repeat(32)}${randomUUID().replaceAll("-", "")}`,
      ]
    )
    await expect(
      broker.stop({
        operationId: stopFixture.operationId,
        attemptId: stopPrepared.attemptId,
        workerInstanceId: otherStopInstanceId,
        workerGrantId: otherStopGrantId,
        authorityEpochId: stopFixture.epochId,
        reasonCode: "USER_CANCELLED",
      })
    ).rejects.toMatchObject({ code: "DISPATCH_REPLAY_CONFLICT" })
    expect(
      (
        await owner.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "ScanDispatchOutbox" WHERE "operationId"=$1 AND "commandType"=\'STOP\'',
          [stopFixture.operationId]
        )
      ).rows[0]!.count
    ).toBe("0")

    const reconcileFixture = await legacyPreparationFixture(owner)
    const reconcilePrepared = await historicalPreparation(owner, reconcileFixture)
    if (reconcilePrepared.kind !== "committed")
      throw new Error("fixture preparation did not commit")
    await owner.query(
      `UPDATE "ScanDispatchOperation"
       SET "state"='UNKNOWN', "terminalReason"='AMBIGUOUS_EFFECT', "updatedAt"=CURRENT_TIMESTAMP
       WHERE "operationId"=$1`,
      [reconcileFixture.operationId]
    )

    const otherReconcileGrantId = `authority-grant-other-${reconcileFixture.operationId}`
    const otherReconcileInstanceId = `authority-worker-other-${reconcileFixture.operationId}`
    await owner.query(
      `INSERT INTO "ScanWorkerInstanceGrant"
        ("id","authorityEpochId","instanceId","credentialHash","issuedAt","expiresAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + interval '1 hour',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [
        otherReconcileGrantId,
        reconcileFixture.epochId,
        otherReconcileInstanceId,
        `${"b".repeat(32)}${randomUUID().replaceAll("-", "")}`,
      ]
    )
    await expect(
      broker.reconcile({
        operationId: reconcileFixture.operationId,
        attemptId: reconcilePrepared.attemptId,
        workerInstanceId: otherReconcileInstanceId,
        workerGrantId: otherReconcileGrantId,
        authorityEpochId: reconcileFixture.epochId,
      })
    ).rejects.toMatchObject({ code: "DISPATCH_REPLAY_CONFLICT" })
    expect(
      (
        await owner.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "ScanDispatchOutbox" WHERE "operationId"=$1 AND "commandType"=\'RECONCILE\'',
          [reconcileFixture.operationId]
        )
      ).rows[0]!.count
    ).toBe("0")
  })

  it("rejects preparation after the admitted execution plan changes scope", async () => {
    const fixture = await createFixture()
    await owner.query(
      `UPDATE "Scan" SET "executionPlan"=jsonb_set("executionPlan",'{limits,maxDurationMs}','120000'::jsonb),
         "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
      [fixture.scanId]
    )
    await expect(
      broker.prepare({
        operationId: fixture.operationId,
        workerInstanceId: fixture.instanceId,
        workerGrantId: fixture.grantId,
        authorityEpochId: fixture.epochId,
        expiresAt: await attemptExpiry(),
      })
    ).rejects.toMatchObject({ code: "DATABASE_REJECTED" })
  })

  it("rejects preparation after the admitted target is deleted", async () => {
    const fixture = await createFixture()
    await owner.query(
      'UPDATE "Target" SET "deletedAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [fixture.targetId]
    )
    await expect(
      broker.prepare({
        operationId: fixture.operationId,
        workerInstanceId: fixture.instanceId,
        workerGrantId: fixture.grantId,
        authorityEpochId: fixture.epochId,
        expiresAt: await attemptExpiry(),
      })
    ).rejects.toMatchObject({ code: "DATABASE_REJECTED" })
  })

  it("records one terminal release receipt and rejects a duplicate release", async () => {
    const fixture = await legacyPreparationFixture(owner)
    const prepared = await historicalPreparation(owner, fixture)
    if (prepared.kind !== "committed") throw new Error("fixture preparation did not commit")
    await markPrepared(fixture, prepared.attemptId, prepared.commandId)
    const release = await advanceToRelease(fixture, prepared.attemptId)

    const state = await owner.query<{ physical: string; operation: string; releases: string }>(
      `SELECT (SELECT "state"::text FROM "ScanPhysicalExecution" WHERE "attemptId"=$2) AS physical,
              (SELECT "state"::text FROM "ScanDispatchOperation" WHERE "operationId"=$1) AS operation,
              (SELECT count(*)::text FROM "ScanDispatchReleaseReceipt" WHERE "operationId"=$1) AS releases
       `,
      [fixture.operationId, prepared.attemptId]
    )
    expect(state.rows[0]).toEqual({ physical: "STOPPED", operation: "TERMINATED", releases: "1" })

    const duplicate = await owner
      .query(
        `INSERT INTO "ScanDispatchReleaseReceipt" (
          "id","operationId","attemptId","authorityEpochId","physicalState",
          "supervisorReceiptId","releaseDigest","capacityDisposition","createdAt"
        ) VALUES ($1,$2,$3,$4,'STOPPED',
          (SELECT "supervisorReceiptId" FROM "ScanDispatchReleaseReceipt" WHERE "id"=$5),
          $6,'SETTLED',CURRENT_TIMESTAMP)`,
        [
          `release-duplicate-${fixture.operationId}`,
          fixture.operationId,
          prepared.attemptId,
          fixture.epochId,
          release.releaseId,
          "f".repeat(64),
        ]
      )
      .then(() => "accepted")
      .catch((error: unknown) => (error as { code?: string }).code)
    expect(duplicate).toBe("23505")
  })

  it("denies the application runtime role any privilege on authority tables", async () => {
    const runtimeUrl = process.env.DISPATCH_AUTHORITY_RUNTIME_DATABASE_URL
    if (!runtimeUrl) throw new Error("runtime fixture URL required")
    const runtime = new pg.Client({ connectionString: runtimeUrl })
    await runtime.connect()
    try {
      const authorityTables = [
        "ScanAuthorityEpoch",
        "ScanWorkerInstanceGrant",
        "ScanDispatchOperation",
        "ScanQueueOutbox",
        "ScanDispatchAttempt",
        "ScanDispatchOutbox",
        "ScanDispatchStart",
        "ScanSupervisorReceipt",
        "ScanPhysicalExecution",
        "ScanPhysicalExecutionTransition",
        "ScanDispatchReleaseReceipt",
      ]
      for (const table of authorityTables) {
        const privileges = await runtime.query<{ privilege: string; allowed: boolean }>(
          `SELECT privilege, has_table_privilege(current_user, format('public.%I', $1::text), privilege) AS allowed
           FROM (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) AS privileges(privilege)`,
          [table]
        )
        for (const row of privileges.rows) expect(row.allowed).toBe(false)
      }
      const denial = await runtime
        .query(
          `INSERT INTO "ScanDispatchOperation"
            ("operationId","scanId","workspaceId","requestDigest","createdAt","updatedAt")
           VALUES ('runtime-escalation','scan-x','workspace-x',$1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          ["0".repeat(64)]
        )
        .then(() => "accepted")
        .catch((error: unknown) => (error as { code?: string }).code)
      expect(denial).toBe("42501")
    } finally {
      await runtime.end()
    }
  })

  it("fails closed with no partial state when the protected scan row cannot be locked", async () => {
    const fixture = await createFixture()
    const holder = await owner.connect()
    await holder.query("BEGIN")
    await holder.query('SELECT 1 FROM "Scan" WHERE "id"=$1 FOR UPDATE', [fixture.scanId])
    try {
      await expect(
        broker.prepare({
          operationId: fixture.operationId,
          workerInstanceId: fixture.instanceId,
          workerGrantId: fixture.grantId,
          authorityEpochId: fixture.epochId,
          expiresAt: await attemptExpiry(),
        })
      ).rejects.toMatchObject({ code: "DATABASE_REJECTED" })
      const counts = await owner.query<{
        attempts: string
        physical: string
        commands: string
        state: string
      }>(
        `SELECT
          (SELECT count(*) FROM "ScanDispatchAttempt" WHERE "operationId"=$1)::text AS attempts,
          (SELECT count(*) FROM "ScanPhysicalExecution" WHERE "operationId"=$1)::text AS physical,
          (SELECT count(*) FROM "ScanDispatchOutbox" WHERE "operationId"=$1)::text AS commands,
          (SELECT "state"::text FROM "ScanDispatchOperation" WHERE "operationId"=$1) AS state`,
        [fixture.operationId]
      )
      expect(counts.rows[0]).toEqual({
        attempts: "0",
        physical: "0",
        commands: "0",
        state: "QUEUED",
      })
    } finally {
      await holder.query("ROLLBACK")
      holder.release()
    }
  }, 15_000)
})
