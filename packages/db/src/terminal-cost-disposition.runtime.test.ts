import pg from "pg"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  getSystemPrisma: () => {
    throw new Error("explicit disposable client required")
  },
}))
import { findOldestTerminalUnreconciledCost } from "../../../apps/worker/src/operational-health"

const now = new Date("2026-10-12T12:00:00Z")
const scanId = "caaaaaaaaaaaaaaaaaaaaaaaa"
const metadata = {
  receiptType: "terminal_failed_provider_expense_disposition_v2",
  receiptHash: "a".repeat(64),
  operator: { userId: "test-operator" },
  expectedState: {
    workspaceId: "test-workspace",
    updatedAt: "2026-10-12T11:00:00.000Z",
    providerCostUsd: "0.1234560000",
  },
  conclusion: { providerCostUsd: "0.1234560000", customerBilling: "non_billable_failed_scan" },
}

describe("terminal cost disposition predicate on disposable PostgreSQL", () => {
  let client: pg.Client
  const query = () =>
    findOldestTerminalUnreconciledCost(now, {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.reduce(
          (sql, part, index) => sql + (index ? `$${index}` : "") + part,
          ""
        )
        return (await client.query(text, values)).rows
      },
    } as never)

  beforeAll(async () => {
    if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1")
      throw new Error("disposable database opt-in required")
    client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
  })
  afterAll(async () => {
    await client?.end()
  })
  beforeEach(async () => {
    await client.query("BEGIN")
    await client.query(`
      CREATE TEMP TABLE "Target" (id text, type text) ON COMMIT DROP;
      CREATE TEMP TABLE "Scan" (id text, "targetId" text, "workspaceId" text, status text, "endedAt" timestamp(3), "updatedAt" timestamp(3), "deletedAt" timestamp, "providerCostUsd" numeric(19,10), "billedCostUsd" numeric(19,10)) ON COMMIT DROP;
      CREATE TEMP TABLE "ScanEvent" ("scanId" text, "deletedAt" timestamp, stage text, metadata jsonb) ON COMMIT DROP;
      CREATE TEMP TABLE "PlatformAdminAudit" ("resourceId" text, "resourceType" text, "sessionId" text, action text, "actorUserId" text, metadata jsonb) ON COMMIT DROP;
      INSERT INTO "Target" VALUES ('test-target','REPO');
    `)
    await client.query(
      `INSERT INTO "Scan" VALUES ($1,'test-target','test-workspace','FAILED','2026-10-12T11:00:00','2026-10-12T11:00:00',NULL,0.1234560000,NULL)`,
      [scanId]
    )
  })
  afterEach(async () => {
    await client.query("ROLLBACK")
  })

  const event = async (value: unknown = metadata) =>
    client.query(
      `INSERT INTO "ScanEvent" VALUES ($1,NULL,'terminal_cost_operator_reconciled',$2)`,
      [scanId, JSON.stringify(value)]
    )
  const audit = async (value: unknown = metadata) =>
    client.query(
      `INSERT INTO "PlatformAdminAudit" VALUES ($1,'scan','offline-terminal-cost-review','terminal_cost.operator_disposition_recorded','test-operator',$2)`,
      [scanId, JSON.stringify(value)]
    )

  it("keeps a positive failed-scan expense unresolved without a reviewed disposition", async () => {
    expect((await query())?.id).toBe(scanId)
  })
  it("requires an atomic audit before recognizing a positive disposition", async () => {
    await event()
    expect((await query())?.id).toBe(scanId)
    await audit()
    expect(await query()).toBeNull()
  })
  it("does not turn duplicate receipts into multiple incidents", async () => {
    await event()
    await event()
    await audit()
    expect(await query()).toBeNull()
  })
  it("invalidates a disposition when the scan version or provider expense changes", async () => {
    await event()
    await audit()
    await client.query(`UPDATE "Scan" SET "updatedAt"='2026-10-12T11:00:01'`)
    expect((await query())?.id).toBe(scanId)
    await client.query(`UPDATE "Scan" SET "updatedAt"='2026-10-12T11:00:00', "providerCostUsd"=0.6`)
    expect((await query())?.id).toBe(scanId)
  })
  it("rejects an edited event that retains an older audited receipt hash", async () => {
    await audit()
    await client.query(`UPDATE "Scan" SET "updatedAt"='2026-10-12T11:00:01', "providerCostUsd"=0.6`)
    await event({
      ...metadata,
      expectedState: {
        ...metadata.expectedState,
        updatedAt: "2026-10-12T11:00:01.000Z",
        providerCostUsd: "0.6000000000",
      },
      conclusion: { ...metadata.conclusion, providerCostUsd: "0.6000000000" },
    })
    expect((await query())?.id).toBe(scanId)
  })
  it("rejects malformed, mismatched, and customer-billable dispositions", async () => {
    await audit()
    for (const value of [
      null,
      {},
      { ...metadata, expectedState: { ...metadata.expectedState, workspaceId: "other" } },
      { ...metadata, conclusion: { ...metadata.conclusion, customerBilling: "bill_customer" } },
    ]) {
      await client.query(`DELETE FROM "ScanEvent"`)
      await event(value)
      expect((await query())?.id).toBe(scanId)
    }
  })
  it("recognizes a zero-cost disposition but never hides subsequently recorded expense", async () => {
    await client.query(`UPDATE "Scan" SET "providerCostUsd"=NULL`)
    await client.query(`INSERT INTO "ScanEvent" VALUES ($1,NULL,'llm_usage_unavailable',NULL)`, [
      scanId,
    ])
    const zero = {
      ...metadata,
      receiptType: "terminal_cost_operator_disposition_v1",
      conclusion: { providerCostUsd: "0.000000" },
    }
    await event(zero)
    await audit(zero)
    expect(await query()).toBeNull()
    await client.query(`UPDATE "Scan" SET "providerCostUsd"=0.123456`)
    expect((await query())?.id).toBe(scanId)
  })
  it("selects the next unresolved scan after an accepted disposition", async () => {
    await event()
    await audit()
    await client.query(
      `INSERT INTO "Scan" SELECT 'cbbbbbbbbbbbbbbbbbbbbbbbb',"targetId","workspaceId",status,'2026-10-12T11:30:00',"updatedAt",NULL,1,NULL FROM "Scan"`
    )
    expect((await query())?.id).toBe("cbbbbbbbbbbbbbbbbbbbbbbbb")
  })
})
