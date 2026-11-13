import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({ getSystemPrisma: vi.fn() }))
vi.mock("@lyrashield/config", () => ({
  APPROVED_PLATFORM_ADMIN_EMAILS: ["ankit@lyrashieldai.com"],
}))

import {
  createTerminalCostDispositionDbDeps,
  parseTerminalCostDispositionReceipt,
  reviewTerminalCostDisposition,
  terminalCostDispositionReceiptHash,
  verifyTerminalCostEvidenceFiles,
} from "./review-terminal-cost-disposition"
import { historicalExpenseReceiptSchema } from "./historical-failed-expense-contract"

const scanId = "cmue3iw3s000201hs9zkd26on"
const workspaceId = "cmrtq1zdx00000124rxffgrlg"
const usageMetadataJson = JSON.stringify({
  requestCount: 428,
  engineReportedCostUsd: 0.567612455,
  costSource: "engine_reported_unreconciled",
  pricingMethod: "unavailable",
  reconciliationStatus: "unavailable",
})

function historicalReceipt() {
  const historicalEvidence = {
    kind: "scan_bound_historical_engine_usage",
    eventId: "cmue3yfph000g0nnt64xf0qrn",
    eventCreatedAt: "2026-09-23T12:57:32.165Z",
    engineReportedCostUsd: "0.5676124550",
    requestCount: 428,
    usageMetadataSha256: createHash("sha256").update(usageMetadataJson).digest("hex"),
    productRevision: "c548418dd673e45145dbd02f6b1a14e33b51767f",
    usageWriterSha256: "14168782281ec28bd6cfa64e14723758434e59f19a078a3381a11f787f59a705",
    scanSchemaSha256: "b41d6073c416af443945c0fac19e8aa1b400ce091b2b4f9b5703a9f2190409b7",
    storageDecimalPlaces: 6,
    rounding: "javascript_toFixed_6",
    manifestVersion: 7,
    manifestChecksumState: "legacy_unavailable",
    usageEventCount: 1,
    customerUsageRecordCount: 0,
    queryTimestamp: "2026-10-13T00:00:00.000Z",
  }
  const evidence = Buffer.from(
    JSON.stringify({ version: 3, scanId, workspaceId, ...historicalEvidence })
  )
  return {
    version: 3,
    environment: "production",
    operator: { userId: "test-operator", email: "ankit@lyrashieldai.com" },
    scans: [
      {
        scanId,
        expectedState: {
          workspaceId,
          targetType: "REPO",
          status: "FAILED",
          startedAt: "2026-09-23T12:45:28.404Z",
          endedAt: "2026-09-23T12:57:32.463Z",
          updatedAt: "2026-09-23T12:57:32.464Z",
          deletedAt: null,
          providerCostUsd: "0.5676120000",
          billedCostUsd: null,
          actualCostCents: null,
          llmRequestCount: 428,
          llmUsageUnavailableEventCount: 0,
        },
        historicalEvidence: {
          ...historicalEvidence,
          evidenceSha256: createHash("sha256").update(evidence).digest("hex"),
        },
        conclusion: {
          providerCostUsd: "0.5676120000",
          originalEngineReportedCostUsd: "0.5676124550",
          roundingDifferenceUsd: "0.0000004550",
          customerBilling: "non_billable_failed_scan",
          providerReconciliation: "unavailable",
          disposition: "reviewed_legacy_engine_expense",
          basis: "Retain historical expense and raw telemetry; no provider reconciliation claim.",
        },
      },
    ],
  }
}

describe("exact historical failed expense review", () => {
  it("returns a validation failure for a missing historical scan", () => {
    expect(
      historicalExpenseReceiptSchema.safeParse({ ...historicalReceipt(), scans: [] }).success
    ).toBe(false)
  })
  it("retains raw expense and its explicit historical rounding difference", () => {
    expect(parseTerminalCostDispositionReceipt(historicalReceipt())).toMatchObject({
      version: 3,
      scans: [
        {
          expectedState: { providerCostUsd: "0.5676120000", billedCostUsd: null },
          conclusion: {
            providerCostUsd: "0.5676120000",
            originalEngineReportedCostUsd: "0.5676124550",
            roundingDifferenceUsd: "0.0000004550",
            providerReconciliation: "unavailable",
          },
        },
      ],
    })
  })

  it("does not generalize historical rounding to another scan, revision, amount or customer charge", () => {
    const input = historicalReceipt()
    const scan = input.scans[0]!
    for (const change of [
      { scanId: "caaaaaaaaaaaaaaaaaaaaaaaa" },
      { expectedState: { ...scan.expectedState, workspaceId: "other" } },
      { expectedState: { ...scan.expectedState, actualCostCents: 57 } },
      { expectedState: { ...scan.expectedState, status: "COMPLETED" } },
      { expectedState: { ...scan.expectedState, providerCostUsd: "0.5676124550" } },
      { historicalEvidence: { ...scan.historicalEvidence, productRevision: "a".repeat(40) } },
      { historicalEvidence: { ...scan.historicalEvidence, usageWriterSha256: "a".repeat(64) } },
      { historicalEvidence: { ...scan.historicalEvidence, storageDecimalPlaces: 10 } },
      { historicalEvidence: { ...scan.historicalEvidence, engineReportedCostUsd: "0.5676124540" } },
      { historicalEvidence: { ...scan.historicalEvidence, customerUsageRecordCount: 1 } },
      { conclusion: { ...scan.conclusion, roundingDifferenceUsd: "0.0000000000" } },
      { conclusion: { ...scan.conclusion, providerReconciliation: "matched" } },
      { conclusion: { ...scan.conclusion, customerBilling: "bill_customer" } },
    ]) {
      expect(() =>
        parseTerminalCostDispositionReceipt({ ...input, scans: [{ ...scan, ...change }] })
      ).toThrow()
    }
  })

  it("keeps version 2 exact at ten decimals even for this historical amount", () => {
    const legacy = historicalReceipt().scans[0]!
    expect(() =>
      parseTerminalCostDispositionReceipt({
        version: 2,
        environment: "production",
        operator: { userId: "test-operator" },
        scans: [
          {
            scanId,
            expectedState: legacy.expectedState,
            conclusion: {
              providerCostUsd: "0.5676120000",
              customerBilling: "non_billable_failed_scan",
              basis: "No broad rounding tolerance.",
            },
            azureEvidence: {
              resourceId:
                "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/lyrashield/providers/Microsoft.CognitiveServices/accounts/provider",
              timeWindowStart: legacy.expectedState.startedAt,
              timeWindowEnd: legacy.expectedState.endedAt,
              queryTimestamp: "2026-10-13T00:00:00.000Z",
              metricTotals: { providerRequestCount: 428, providerCostUsd: "0.5676124550" },
              evidenceSha256: "a".repeat(64),
            },
          },
        ],
      })
    ).toThrow()
  })

  it("rechecks scan-bound durable usage/source evidence during dry-run and fails on drift", async () => {
    const input = historicalReceipt()
    const historicalEvidence = input.scans[0]!.historicalEvidence
    const inspection = { ...historicalEvidence }
    const deps = {
      inspectOperator: vi.fn().mockResolvedValue({
        id: input.operator.userId,
        email: input.operator.email,
        emailVerified: true,
        twoFactorEnabled: true,
        platformRole: "PLATFORM_OPERATOR",
      }),
      inspect: vi.fn().mockResolvedValue(input.scans[0]!.expectedState),
      inspectHistoricalEvidence: vi.fn().mockResolvedValue(inspection),
      append: vi.fn(),
    }
    await expect(reviewTerminalCostDisposition(input, false, deps as never)).resolves.toMatchObject(
      {
        overall: "preflight_passed",
      }
    )
    expect(deps.inspectHistoricalEvidence).toHaveBeenCalledWith(scanId, workspaceId)
    expect(deps.append).not.toHaveBeenCalled()
    for (const changed of [
      null,
      { ...inspection, usageMetadataSha256: "a".repeat(64) },
      { ...inspection, productRevision: "a".repeat(40) },
      { ...inspection, customerUsageRecordCount: 1 },
      { ...inspection, usageEventCount: 2 },
      { ...inspection, manifestChecksumState: "available" },
    ]) {
      deps.inspectHistoricalEvidence.mockResolvedValue(changed)
      await expect(reviewTerminalCostDisposition(input, true, deps as never)).rejects.toThrow(
        "historical usage evidence"
      )
      expect(deps.append).not.toHaveBeenCalled()
    }
  })

  it("binds the historical evidence file without manufacturing Azure provider totals", async () => {
    const parsed = parseTerminalCostDispositionReceipt(historicalReceipt())
    const input = historicalReceipt().scans[0]!.historicalEvidence
    const { evidenceSha256, ...evidence } = input
    const bytes = Buffer.from(JSON.stringify({ version: 3, scanId, workspaceId, ...evidence }))
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(evidenceSha256)
    await expect(
      verifyTerminalCostEvidenceFiles(parsed, [`${scanId}=/historical-evidence`], async () => bytes)
    ).resolves.toBeUndefined()
    await expect(
      verifyTerminalCostEvidenceFiles(parsed, [`${scanId}=/historical-evidence`], async () =>
        Buffer.from(
          JSON.stringify({ version: 3, scanId, workspaceId, ...evidence, requestCount: 429 })
        )
      )
    ).rejects.toThrow("does not match receipt")
  })

  it("appends an idempotent internal audit/event pair without reconciling providers or charging customers", async () => {
    const parsed = parseTerminalCostDispositionReceipt(historicalReceipt())
    const state = parsed.scans[0]!.expectedState
    const current = {
      ...state,
      target: { type: "REPO" },
      startedAt: new Date(state.startedAt),
      endedAt: new Date(state.endedAt),
      updatedAt: new Date(state.updatedAt!),
      providerCostUsd: { toFixed: () => "0.5676120000" },
      _count: { events: 0 },
    }
    const durable = {
      eventId: "cmue3yfph000g0nnt64xf0qrn",
      eventCreatedAt: new Date("2026-09-23T12:57:32.165Z"),
      usageMetadataJson,
      productRevision: "c548418dd673e45145dbd02f6b1a14e33b51767f",
      manifestVersion: 7,
      hasStoredChecksumInput: false,
      usageEventCount: 1,
      customerUsageRecordCount: 0,
    }
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([durable]),
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: parsed.operator.userId,
          email: parsed.operator.email,
          emailVerified: true,
          twoFactorEnabled: true,
          platformRole: "PLATFORM_OPERATOR",
        }),
      },
      scan: { findUnique: vi.fn().mockResolvedValue(current), update: vi.fn() },
      usageRecord: { create: vi.fn(), update: vi.fn() },
      scanEvent: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
      platformAdminAudit: { create: vi.fn(), findUnique: vi.fn() },
    }
    const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx)
    )
    const dbDeps = createTerminalCostDispositionDbDeps({
      ...tx,
      $transaction: transaction,
    } as never)
    await expect(reviewTerminalCostDisposition(parsed, false, dbDeps)).resolves.toMatchObject({
      overall: "preflight_passed",
    })
    expect(tx.scanEvent.create).not.toHaveBeenCalled()
    const receiptHash = terminalCostDispositionReceiptHash(parsed)
    await expect(dbDeps.append(parsed.scans, { reviewed: parsed, receiptHash })).resolves.toEqual([
      { scanId, result: "created" },
    ])
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    })
    expect(tx.scanEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stage: "terminal_cost_legacy_expense_reviewed",
          metadata: expect.objectContaining({
            receiptType: "terminal_failed_legacy_expense_review_v3",
            conclusion: expect.objectContaining({
              providerCostUsd: "0.5676120000",
              originalEngineReportedCostUsd: "0.5676124550",
              roundingDifferenceUsd: "0.0000004550",
              providerReconciliation: "unavailable",
              customerBilling: "non_billable_failed_scan",
            }),
          }),
        }),
      })
    )
    const metadata = tx.scanEvent.create.mock.calls[0]![0].data.metadata
    expect(metadata).not.toHaveProperty("azureEvidence")
    expect(tx.platformAdminAudit.create.mock.calls[0]![0].data).toMatchObject({
      action: "terminal_cost.legacy_expense_review_recorded",
      metadata,
    })
    expect(tx.scan.update).not.toHaveBeenCalled()
    expect(tx.usageRecord.create).not.toHaveBeenCalled()
    expect(tx.usageRecord.update).not.toHaveBeenCalled()
    tx.scanEvent.findUnique.mockResolvedValue({
      scanId,
      stage: "terminal_cost_legacy_expense_reviewed",
      deletedAt: null,
      metadata,
    })
    tx.platformAdminAudit.findUnique.mockResolvedValue({
      actorUserId: parsed.operator.userId,
      sessionId: "offline-terminal-cost-review",
      action: "terminal_cost.legacy_expense_review_recorded",
      resourceType: "scan",
      resourceId: scanId,
      metadata,
    })
    await expect(dbDeps.append(parsed.scans, { reviewed: parsed, receiptHash })).resolves.toEqual([
      { scanId, result: "existing" },
    ])
    expect(tx.scanEvent.create).toHaveBeenCalledTimes(1)
    expect(tx.platformAdminAudit.create).toHaveBeenCalledTimes(1)

    // Drift after the successful dry-run must be caught inside the transaction.
    tx.$queryRaw.mockResolvedValue([{ ...durable, customerUsageRecordCount: 1 }])
    await expect(dbDeps.append(parsed.scans, { reviewed: parsed, receiptHash })).rejects.toThrow(
      "historical usage evidence"
    )
    expect(tx.scanEvent.create).toHaveBeenCalledTimes(1)
    expect(tx.platformAdminAudit.create).toHaveBeenCalledTimes(1)
  })
})
