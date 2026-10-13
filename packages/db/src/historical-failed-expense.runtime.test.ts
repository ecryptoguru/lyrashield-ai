import { createHash } from "node:crypto"
import pg from "pg"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  getSystemPrisma: () => {
    throw new Error("explicit disposable client required")
  },
}))
import { findOldestTerminalUnreconciledCost } from "../../../apps/worker/src/operational-health"
import { HISTORICAL_FAILED_EXPENSE } from "../../../apps/worker/src/operations/historical-failed-expense-contract"
import {
  assertHistoricalExpenseEvidence,
  readHistoricalExpenseEvidence,
} from "../../../apps/worker/src/operations/historical-failed-expense-evidence"

const { scanId, workspaceId, eventId, productRevision } = HISTORICAL_FAILED_EXPENSE
const metadata = {
  engineReportedCostUsd: 0.567612455,
  requestCount: 428,
  costSource: "engine_reported_unreconciled",
  pricingMethod: "unavailable",
  reconciliationStatus: "unavailable",
}

describe("historical expense evidence on disposable PostgreSQL", () => {
  let client: pg.Client
  const adapter = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((sql, part, i) => sql + (i ? `$${i}` : "") + part, "")
      return (await client.query(text, values)).rows
    },
  }
  const inspect = (workspace = workspaceId) =>
    readHistoricalExpenseEvidence(adapter as never, scanId, workspace)

  beforeAll(async () => {
    if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1")
      throw new Error("disposable database opt-in required")
    client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
  })
  afterAll(async () => client?.end())
  beforeEach(async () => {
    await client.query("BEGIN")
    await client.query(`
      CREATE TEMP TABLE "Target" (id text, type text) ON COMMIT DROP;
      CREATE TEMP TABLE "Scan" (id text, "workspaceId" text, "targetId" text, status text,
        "endedAt" timestamp(3), "updatedAt" timestamp(3), "deletedAt" timestamp,
        "providerCostUsd" numeric(19,10), "billedCostUsd" numeric(19,10),
        "sponsorAccountId" text, "createdById" text) ON COMMIT DROP;
      CREATE TEMP TABLE "ScanEvent" (id text, "scanId" text, stage text,
        "createdAt" timestamp(3), "deletedAt" timestamp, metadata jsonb) ON COMMIT DROP;
      CREATE TEMP TABLE "ScanResultManifest" ("scanId" text, version int, manifest jsonb,
        "checksumInput" text) ON COMMIT DROP;
      CREATE TEMP TABLE "UsageRecord" ("workspaceId" text, "accountId" text,
        "idempotencyKey" text, metadata jsonb) ON COMMIT DROP;
      CREATE TEMP TABLE "PlatformAdminAudit" ("resourceId" text, "resourceType" text,
        "sessionId" text, action text, "actorUserId" text, metadata jsonb) ON COMMIT DROP;
      INSERT INTO "Target" VALUES ('target','REPO');
    `)
    await client.query(
      `INSERT INTO "Scan" VALUES ($1,$2,'target','FAILED','2026-09-23T12:57:32.463',
        '2026-09-23T12:57:32.464',NULL,0.5676120000,NULL,'sponsor','creator')`,
      [scanId, workspaceId]
    )
    await client.query(
      `INSERT INTO "ScanEvent" VALUES ($1,$2,'llm_usage','2026-09-23T12:57:32.165',NULL,$3)`,
      [eventId, scanId, JSON.stringify(metadata)]
    )
    await client.query(`INSERT INTO "ScanResultManifest" VALUES ($1,7,$2,NULL)`, [
      scanId,
      JSON.stringify({ workerExecution: { productRevision } }),
    ])
  })
  afterEach(async () => client.query("ROLLBACK"))

  it("retains the original numeric expense and hashes its original JSONB bytes", async () => {
    const original = await client.query(`SELECT metadata::text FROM "ScanEvent" WHERE id=$1`, [
      eventId,
    ])
    expect(await inspect()).toMatchObject({
      eventId,
      engineReportedCostUsd: "0.5676124550",
      productRevision,
      manifestChecksumState: "legacy_unavailable",
      usageEventCount: 1,
      customerUsageRecordCount: 0,
      usageMetadataSha256: createHash("sha256").update(original.rows[0].metadata).digest("hex"),
    })
    expect((await client.query(`SELECT "providerCostUsd"::text FROM "Scan"`)).rows[0]).toEqual({
      providerCostUsd: "0.5676120000",
    })
  })

  it("binds the evidence to its exact workspace and nondeleted original event", async () => {
    expect(await inspect("other" as typeof workspaceId)).toBeNull()
    await client.query(`UPDATE "ScanEvent" SET "deletedAt"=now()`)
    expect(await inspect()).toBeNull()
  })

  it("rejects changed usage bytes or source revision after the original review", async () => {
    const original = (await inspect())!
    await client.query(`UPDATE "ScanEvent" SET metadata=metadata || '{"newCounter":1}'::jsonb`)
    const changed = await inspect()
    expect(() => assertHistoricalExpenseEvidence(changed, original as never)).toThrow(
      "historical usage evidence"
    )
    await client.query(`UPDATE "ScanEvent" SET metadata=$1`, [JSON.stringify(metadata)])
    await client.query(`UPDATE "ScanResultManifest" SET manifest=$1`, [
      JSON.stringify({ workerExecution: { productRevision: "a".repeat(40) } }),
    ])
    const changedRevision = await inspect()
    expect(() => assertHistoricalExpenseEvidence(changedRevision, original as never)).toThrow()
  })

  it("counts customer usage by sponsor ownership even when workspace attribution differs", async () => {
    await client.query(`INSERT INTO "UsageRecord" VALUES ('other','sponsor',NULL,$1)`, [
      JSON.stringify({ scanId }),
    ])
    expect(await inspect()).toMatchObject({ customerUsageRecordCount: 1 })
  })

  it("does not call a historical internal review provider reconciliation or suppress cost health", async () => {
    const review = {
      receiptType: "terminal_failed_legacy_expense_review_v3",
      conclusion: {
        providerCostUsd: "0.5676120000",
        originalEngineReportedCostUsd: "0.5676124550",
        roundingDifferenceUsd: "0.0000004550",
        providerReconciliation: "unavailable",
        customerBilling: "non_billable_failed_scan",
      },
    }
    await client.query(
      `INSERT INTO "ScanEvent" VALUES ('review',$1,'terminal_cost_legacy_expense_reviewed',now(),NULL,$2)`,
      [scanId, JSON.stringify(review)]
    )
    expect(
      await findOldestTerminalUnreconciledCost(new Date("2026-10-13T00:00:00Z"), adapter as never)
    ).toMatchObject({ id: scanId })
    expect(await inspect()).toMatchObject({ customerUsageRecordCount: 0 })
  })
})
