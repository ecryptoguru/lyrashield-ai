import assert from "node:assert/strict"
import test from "node:test"
import {
  collectLegacyAccountingDiagnostic,
  diagnoseLegacyAccountingSnapshot,
} from "../v26-accounting-diagnostic.mjs"

const scan = (overrides = {}) => ({
  id: "scan-private",
  workspaceId: "workspace-private",
  createdById: "creator-private",
  sponsorAccountId: "account-private",
  status: "COMPLETED",
  startedAt: "2026-10-30T01:00:00.000Z",
  endedAt: "2026-10-30T01:01:00.000Z",
  finalizationStartedAt: "2026-10-30T01:00:30.000Z",
  deletedAt: null,
  ...overrides,
})
const intent = (overrides = {}) => ({
  scanId: "scan-private",
  metadata: {
    workspaceId: "workspace-private",
    accountId: "account-private",
    idempotencyKey: "workspace-private:scan-private:engine_run",
    automaticReplayAllowed: false,
  },
  ...overrides,
})
const receipt = (overrides = {}) => ({
  workspaceId: "workspace-private",
  accountId: "account-private",
  idempotencyKey: "workspace-private:scan-private:engine_run",
  kind: "agent_minutes",
  deletedAt: null,
  metadata: { scanId: "scan-private", accountId: "account-private" },
  ...overrides,
})
const snapshot = (overrides = {}) => ({
  complete: true,
  scans: [scan()],
  intents: [intent()],
  receipts: [receipt()],
  ...overrides,
})

test("matches a durable receipt only to its recorded scan, account and workspace", () => {
  const result = diagnoseLegacyAccountingSnapshot(snapshot())
  assert.equal(result.status, "NO_DETECTED_DB_BLOCKERS")
  assert.equal(result.counts.settledReceipts, 1)
  assert.equal(result.cutoverReady, false)
  assert.doesNotMatch(JSON.stringify(result), /private|engine_run/)
})

test("a finalization claim retained on a terminal scan is not itself an unsettled obligation", () => {
  const result = diagnoseLegacyAccountingSnapshot(snapshot())
  assert.equal(result.counts.unsettledIntents, 0)
  assert.equal(result.status, "NO_DETECTED_DB_BLOCKERS")
  assert.equal(result.cutoverReady, false)
})

test("legacy null sponsor resolves to the recorded creator", () => {
  const result = diagnoseLegacyAccountingSnapshot(
    snapshot({
      scans: [scan({ sponsorAccountId: null })],
      intents: [intent({ metadata: { ...intent().metadata, accountId: "creator-private" } })],
      receipts: [
        receipt({
          accountId: "creator-private",
          metadata: { scanId: "scan-private", accountId: "creator-private" },
        }),
      ],
    })
  )
  assert.equal(result.status, "NO_DETECTED_DB_BLOCKERS")
  assert.equal(result.counts.settledReceipts, 1)
})

test("idempotent duplicate intent events refer to one monetary receipt", () => {
  const result = diagnoseLegacyAccountingSnapshot(snapshot({ intents: [intent(), intent()] }))
  assert.equal(result.status, "NO_DETECTED_DB_BLOCKERS")
  assert.equal(result.counts.settledReceipts, 1)
})

test("empty inventory does not certify stopped processes, queues or a release", () => {
  const result = diagnoseLegacyAccountingSnapshot(
    snapshot({ scans: [], intents: [], receipts: [] })
  )
  assert.equal(result.status, "NO_DETECTED_DB_BLOCKERS")
  assert.equal(result.cutoverReady, false)
})

test("nonterminal scans always block regardless of age or receipt", () => {
  for (const status of ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING", "REQUIRES_APPROVAL"]) {
    const result = diagnoseLegacyAccountingSnapshot(snapshot({ scans: [scan({ status })] }))
    assert.equal(result.status, "REVIEW_REQUIRED", status)
    assert.equal(result.counts.activeScans, 1, status)
  }
})

test("terminal records without positive accounting evidence stay unknown", () => {
  for (const status of [
    "COMPLETED",
    "PARTIAL",
    "FAILED",
    "CANCELLED",
    "STOPPED_BUDGET",
    "TIMED_OUT",
  ]) {
    const result = diagnoseLegacyAccountingSnapshot(
      snapshot({ scans: [scan({ status })], intents: [], receipts: [] })
    )
    assert.equal(result.status, "NO_DETECTED_DB_BLOCKERS", status)
    assert.equal(result.historyDispositionComplete, false, status)
    assert.equal(result.counts.unknownDisposition, 1, status)
  }
})

test("an intent without an exact durable receipt cannot be released", () => {
  const result = diagnoseLegacyAccountingSnapshot(snapshot({ receipts: [] }))
  assert.equal(result.status, "REVIEW_REQUIRED")
  assert.equal(result.counts.unsettledIntents, 1)
})

test("wrong scan, sponsor, workspace, key, kind, or deleted receipt never matches", () => {
  const alternatives = [
    { metadata: { scanId: "other", accountId: "account-private" } },
    { metadata: { scanId: "scan-private", accountId: "other" } },
    { accountId: "other" },
    { workspaceId: "other" },
    { idempotencyKey: "other" },
    { kind: "pool_grant" },
    { deletedAt: "2026-10-30T02:00:00.000Z" },
  ]
  for (const alteration of alternatives) {
    const result = diagnoseLegacyAccountingSnapshot(snapshot({ receipts: [receipt(alteration)] }))
    assert.equal(result.status, "REVIEW_REQUIRED")
    assert.equal(result.counts.unsettledIntents, 1)
    assert.doesNotMatch(JSON.stringify(result), /private|engine_run|other/)
  }
})

test("malformed intent, orphan records and unsupported status require review", () => {
  for (const input of [
    snapshot({ intents: [intent({ metadata: null })] }),
    snapshot({ intents: [intent({ scanId: "orphan" })] }),
    snapshot({ scans: [scan({ status: "UNRECOGNIZED" })] }),
    snapshot({ scans: [scan({ endedAt: null })] }),
    snapshot({ scans: [scan({ endedAt: "invalid" })] }),
  ])
    assert.equal(diagnoseLegacyAccountingSnapshot(input).status, "REVIEW_REQUIRED")
})

test("failed scan with a receipt is a policy conflict, never silently certified", () => {
  const result = diagnoseLegacyAccountingSnapshot(snapshot({ scans: [scan({ status: "FAILED" })] }))
  assert.equal(result.status, "REVIEW_REQUIRED")
  assert.equal(result.counts.failedScanReceipts, 1)
})

test("incomplete, oversized, duplicate or structurally malformed snapshots fail closed", () => {
  for (const input of [
    null,
    {},
    snapshot({ complete: false }),
    snapshot({ scans: [scan(), scan()] }),
    snapshot({ intents: new Array(10_001).fill(intent()) }),
    snapshot({ receipts: [receipt(), receipt()] }),
    snapshot({ scans: [scan({ id: "" })] }),
  ]) {
    const result = diagnoseLegacyAccountingSnapshot(input)
    assert.equal(result.status, "REVIEW_REQUIRED")
    assert.equal(result.cutoverReady, false)
    assert.doesNotMatch(JSON.stringify(result), /private|engine_run/)
  }
})

test("a valid receipt without an intent is retained as unknown rather than a debt", () => {
  const result = diagnoseLegacyAccountingSnapshot(snapshot({ intents: [] }))
  assert.equal(result.status, "NO_DETECTED_DB_BLOCKERS")
  assert.equal(result.historyDispositionComplete, false)
  assert.equal(result.counts.receiptWithoutIntent, 1)
  assert.equal(result.counts.unsettledIntents, 0)
  assert.equal(result.counts.unknownDisposition, 1)
})

const historicalScan = (overrides = {}) =>
  scan({
    startedAt: "2026-08-28T00:00:00.000Z",
    endedAt: "2026-08-28T00:01:00.000Z",
    finalizationStartedAt: null,
    ...overrides,
  })
const historicalReceipt = (overrides = {}) =>
  receipt({
    createdAt: "2026-08-28T00:00:30.000Z",
    quantity: 1,
    cycleStart: null,
    metadata: { scanId: "scan-private" },
    ...overrides,
  })

test("pre-policy receipts are counted as unresolved history without certifying settlement or nonbilling", () => {
  for (const status of [
    "COMPLETED",
    "PARTIAL",
    "FAILED",
    "CANCELLED",
    "STOPPED_BUDGET",
    "TIMED_OUT",
  ]) {
    const input = snapshot({
      scans: [historicalScan({ status })],
      intents: [],
      receipts: [historicalReceipt()],
    })
    const before = structuredClone(input)
    const result = diagnoseLegacyAccountingSnapshot(input)
    assert.equal(result.status, "NO_DETECTED_DB_BLOCKERS", status)
    assert.equal(result.counts.legacyHistoricalReceipts, 1)
    assert.equal(result.counts.legacyFailedReceipts, status === "FAILED" ? 1 : 0)
    assert.equal(result.counts.failedScanReceipts, 0)
    assert.equal(result.counts.settledReceipts, 0)
    assert.equal(result.counts.unknownDisposition, 1)
    assert.equal(result.historyDispositionComplete, false)
    assert.equal(result.cutoverReady, false)
    assert.deepEqual(input, before)
    assert.doesNotMatch(JSON.stringify(result), /private|engine_run|nonbillable/i)
  }
})

test("historical classification requires strict timestamps, live bindings and unambiguous legacy metadata", () => {
  const cases = [
    ["usage", { createdAt: "2026-08-29T00:00:00.000Z" }],
    ["scan", { endedAt: "2026-08-29T00:00:00.000Z" }],
    ["scan", { endedAt: "2026-10-30T00:00:00.000Z" }],
    ["usage", { createdAt: "2026-08-28T00:02:00.000Z" }],
    ["usage", { createdAt: null }],
    ["usage", { createdAt: "invalid" }],
    ["usage", { quantity: 0 }],
    ["usage", { quantity: -1 }],
    ["usage", { quantity: 0.5 }],
    ["usage", { quantity: "1" }],
    ["usage", { quantity: undefined }],
    ["usage", { cycleStart: "2026-08-01T00:00:00.000Z" }],
    ["usage", { cycleStart: undefined }],
    ["usage", { accountId: "other" }],
    ["usage", { workspaceId: "other" }],
    ["usage", { idempotencyKey: "other" }],
    ["usage", { kind: "pool_grant" }],
    ["usage", { deletedAt: "2026-08-28T02:00:00.000Z" }],
    ["scan", { deletedAt: "2026-08-28T02:00:00.000Z" }],
    ["scan", { deletedAt: undefined }],
    ["usage", { metadata: { scanId: "other" } }],
    ["usage", { metadata: { scanId: "scan-private", accountId: "other" } }],
    ["usage", { metadata: { scanId: "scan-private", accountId: null } }],
    ["usage", { metadata: { scanId: "scan-private", accountId: 1 } }],
    ["usage", { metadata: null }],
  ]
  for (const [kind, change] of cases) {
    const result = diagnoseLegacyAccountingSnapshot(
      snapshot({
        scans: [historicalScan({ status: "FAILED", ...(kind === "scan" ? change : {}) })],
        intents: [],
        receipts: [historicalReceipt(kind === "usage" ? change : {})],
      })
    )
    assert.equal(result.status, "REVIEW_REQUIRED", JSON.stringify([kind, change]))
    assert.equal(result.counts.legacyHistoricalReceipts, 0)
    assert.equal(result.counts.legacyFailedReceipts, 0)
  }
})

test("historical receipt never excuses any settlement intent or active scan", () => {
  for (const active of ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING", "REQUIRES_APPROVAL"]) {
    const result = diagnoseLegacyAccountingSnapshot(
      snapshot({
        scans: [historicalScan({ status: active })],
        intents: [],
        receipts: [historicalReceipt()],
      })
    )
    assert.equal(result.status, "REVIEW_REQUIRED")
    assert.equal(result.counts.activeScans, 1)
    assert.equal(result.counts.legacyHistoricalReceipts, 0)
  }
  for (const event of [
    intent(),
    intent({ metadata: null }),
    intent({ metadata: { ...intent().metadata, idempotencyKey: "other" } }),
  ]) {
    const result = diagnoseLegacyAccountingSnapshot(
      snapshot({ scans: [historicalScan()], intents: [event], receipts: [historicalReceipt()] })
    )
    assert.equal(result.status, "REVIEW_REQUIRED")
    assert.equal(result.counts.legacyHistoricalReceipts, 0)
  }
})

test("current failed-scan billing policy and account metadata checks remain strict", () => {
  for (const input of [
    snapshot({ scans: [scan({ status: "FAILED" })], intents: [] }),
    snapshot({
      scans: [scan({ status: "FAILED" })],
      intents: [],
      receipts: [historicalReceipt({ createdAt: "2026-10-30T01:00:30.000Z" })],
    }),
    snapshot({
      scans: [historicalScan({ status: "FAILED" })],
      intents: [],
      receipts: [
        historicalReceipt({ metadata: { scanId: "scan-private", accountId: "account-private" } }),
      ],
    }),
  ]) {
    const result = diagnoseLegacyAccountingSnapshot(input)
    assert.equal(result.status, "REVIEW_REQUIRED")
    assert.equal(result.counts.legacyHistoricalReceipts, 0)
  }
})

test("retained receipts with deleted scan or workspace remain historical unknowns", () => {
  for (const retained of [
    receipt(),
    receipt({ workspaceId: null, accountId: null }),
    receipt({ workspaceId: null, accountId: null, idempotencyKey: null, metadata: null }),
  ]) {
    const result = diagnoseLegacyAccountingSnapshot(
      snapshot({ scans: [], intents: [], receipts: [retained] })
    )
    assert.equal(result.status, "NO_DETECTED_DB_BLOCKERS")
    assert.equal(result.counts.orphanHistoryReceipts, 1)
    assert.equal(result.counts.unsettledIntents, 0)
    assert.equal(result.historyDispositionComplete, false)
    assert.equal(result.cutoverReady, false)
    assert.doesNotMatch(JSON.stringify(result), /private|engine_run/)
  }
})

test("an incorrectly bound receipt for an identifiable scan remains a blocker", () => {
  const result = diagnoseLegacyAccountingSnapshot(
    snapshot({ intents: [], receipts: [receipt({ accountId: "other" })] })
  )
  assert.equal(result.status, "REVIEW_REQUIRED")
  assert.equal(result.counts.unboundReceipts, 1)
  assert.equal(result.historyDispositionComplete, false)
})

test("collector fails closed if role visibility, database query or rollback is uncertain", async () => {
  const client = {
    query: async (sql) => {
      if (sql.includes("FROM pg_catalog.pg_roles")) {
        return {
          rows: [
            {
              rolsuper: false,
              rolbypassrls: false,
              read_only: "on",
              isolation: "repeatable read",
              row_security: "off",
            },
          ],
        }
      }
      if (sql === "ROLLBACK") throw new Error("private connection detail")
      return { rows: [] }
    },
  }
  const result = await collectLegacyAccountingDiagnostic(client)
  assert.equal(result.status, "REVIEW_REQUIRED")
  assert.equal(result.cutoverReady, false)
  assert.equal(result.counts.malformedSnapshot, 1)
  assert.doesNotMatch(JSON.stringify(result), /private/)
})
