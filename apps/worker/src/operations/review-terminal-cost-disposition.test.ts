import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({ getSystemPrisma: vi.fn() }))
vi.mock("@lyrashield/config", () => ({
  APPROVED_PLATFORM_ADMIN_EMAILS: ["ecryptoguru@gmail.com", "ankit@lyrashieldai.com"],
}))

import {
  assertExpectedAzureResourceId,
  createTerminalCostDispositionDbDeps,
  parseTerminalCostDispositionReceipt,
  reviewTerminalCostDisposition,
  terminalCostDispositionRecordIds,
  terminalCostDispositionReceiptHash,
  verifyTerminalCostEvidenceFiles,
  type TerminalCostDispositionDeps,
} from "./review-terminal-cost-disposition"

const scanIds = ["cmsxsrbmb000001m00cc7e6dx", "cmsxuqxpb000001fhcrr6emat"] as const
const azureResourceId =
  "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/lyrashield/providers/Microsoft.OperationalInsights/workspaces/lyrashield-logs"
const azureProviderResourceId =
  "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/InsightAlphaAI/providers/Microsoft.CognitiveServices/accounts/insightalpha-resource"

function evidencePayload(
  index: number,
  metricTotals = { providerRequestCount: 0, providerCostUsd: 0 }
) {
  return {
    version: 1,
    scanId: scanIds[index]!,
    resourceId: azureResourceId,
    timeWindowStart: `2026-08-17T${index === 0 ? "11:59" : "12:19"}:00.000Z`,
    timeWindowEnd: `2026-08-17T12:${index === 0 ? "11" : "31"}:00.000Z`,
    queryTimestamp: "2026-08-25T02:00:00.000Z",
    metricTotals,
  }
}

function evidenceBytes(index: number): Buffer {
  return Buffer.from(JSON.stringify(evidencePayload(index)))
}

function receipt() {
  return {
    version: 1,
    environment: "production",
    operator: { userId: "operator-user-id", email: "ecryptoguru@gmail.com" },
    scans: scanIds.map((scanId, index) => ({
      scanId,
      expectedState: {
        workspaceId: "workspace-1",
        targetType: "REPO",
        status: "FAILED",
        startedAt: `2026-08-17T12:${index === 0 ? "00" : "20"}:00.000Z`,
        endedAt: `2026-08-17T12:${index === 0 ? "10" : "30"}:00.000Z`,
        deletedAt: null,
        providerCostUsd: null,
        billedCostUsd: null,
        llmUsageUnavailableEventCount: 1,
      },
      conclusion: { providerCostUsd: "0.000000", basis: "No provider requests in window." },
      azureEvidence: {
        resourceId: azureResourceId,
        timeWindowStart: `2026-08-17T${index === 0 ? "11:59" : "12:19"}:00.000Z`,
        timeWindowEnd: `2026-08-17T12:${index === 0 ? "11" : "31"}:00.000Z`,
        queryTimestamp: "2026-08-25T02:00:00.000Z",
        metricTotals: { providerRequestCount: 0, providerCostUsd: 0 },
        evidenceSha256: createHash("sha256").update(evidenceBytes(index)).digest("hex"),
      },
    })),
  } as const
}

function deps(overrides: Partial<TerminalCostDispositionDeps> = {}): TerminalCostDispositionDeps {
  return {
    inspectOperator: vi.fn().mockResolvedValue({
      id: "operator-user-id",
      email: "ecryptoguru@gmail.com",
      emailVerified: true,
      twoFactorEnabled: true,
      platformRole: "PLATFORM_OPERATOR",
    }),
    inspect: vi.fn().mockImplementation((scanId: string) => {
      const index = scanIds.indexOf(scanId as (typeof scanIds)[number])
      return Promise.resolve({
        workspaceId: "workspace-1",
        targetType: "REPO",
        status: "FAILED",
        startedAt: `2026-08-17T12:${index === 0 ? "00" : "20"}:00.000Z`,
        endedAt: `2026-08-17T12:${index === 0 ? "10" : "30"}:00.000Z`,
        deletedAt: null,
        providerCostUsd: null,
        billedCostUsd: null,
        llmUsageUnavailableEventCount: 1,
      })
    }),
    append: vi
      .fn()
      .mockResolvedValue(scanIds.map((scanId) => ({ scanId, result: "created" as const }))),
    ...overrides,
  }
}

describe("terminal cost operator disposition", () => {
  it("requires the exact two historical scans and complete Azure evidence bounds", () => {
    expect(parseTerminalCostDispositionReceipt(receipt()).scans.map((scan) => scan.scanId)).toEqual(
      scanIds
    )
    expect(() =>
      parseTerminalCostDispositionReceipt({ ...receipt(), scans: [receipt().scans[0]] })
    ).toThrow()
    expect(() =>
      parseTerminalCostDispositionReceipt({
        ...receipt(),
        scans: receipt().scans.map((scan, index) =>
          index === 0
            ? {
                ...scan,
                azureEvidence: {
                  ...scan.azureEvidence,
                  timeWindowStart: "2026-08-18T00:00:00.000Z",
                  timeWindowEnd: "2026-08-18T00:01:00.000Z",
                },
              }
            : scan
        ),
      })
    ).toThrow()
    expect(() =>
      parseTerminalCostDispositionReceipt({
        ...receipt(),
        scans: receipt().scans.map((scan, index) =>
          index === 0
            ? { ...scan, expectedState: { ...scan.expectedState, providerCostUsd: "0.100000" } }
            : scan
        ),
      })
    ).toThrow()
  })

  it("produces a stable receipt hash independent of object key order", () => {
    const parsed = parseTerminalCostDispositionReceipt(receipt())
    const reordered = parseTerminalCostDispositionReceipt({
      scans: parsed.scans,
      operator: parsed.operator,
      environment: parsed.environment,
      version: parsed.version,
    })
    expect(terminalCostDispositionReceiptHash(reordered)).toBe(
      terminalCostDispositionReceiptHash(parsed)
    )
    expect(terminalCostDispositionRecordIds(scanIds[0], "b".repeat(64))).toEqual(
      terminalCostDispositionRecordIds(scanIds[0], "b".repeat(64))
    )
    expect(terminalCostDispositionRecordIds(scanIds[0], "b".repeat(64))).not.toEqual(
      terminalCostDispositionRecordIds(scanIds[1], "b".repeat(64))
    )
  })

  it("preflights without writes and fails closed if persisted state changed", async () => {
    const dryRunDeps = deps()
    await expect(
      reviewTerminalCostDisposition(receipt(), false, dryRunDeps)
    ).resolves.toMatchObject({
      overall: "preflight_passed",
      scans: [{ result: "verified" }, { result: "verified" }],
    })
    expect(dryRunDeps.append).not.toHaveBeenCalled()

    const changedDeps = deps({
      inspect: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        targetType: "REPO",
        status: "FAILED",
        startedAt: "2026-08-17T12:00:00.000Z",
        endedAt: "2026-08-17T12:10:00.000Z",
        deletedAt: null,
        providerCostUsd: "0.100000",
        billedCostUsd: null,
        llmUsageUnavailableEventCount: 1,
      }),
    })
    await expect(reviewTerminalCostDisposition(receipt(), true, changedDeps)).rejects.toThrow(
      "changed at providerCostUsd"
    )
    expect(changedDeps.append).not.toHaveBeenCalled()
  })

  it("passes one stable receipt hash to the idempotent append path", async () => {
    const applyDeps = deps({
      append: vi
        .fn()
        .mockResolvedValue(scanIds.map((scanId) => ({ scanId, result: "existing" as const }))),
    })
    const result = await reviewTerminalCostDisposition(receipt(), true, applyDeps)
    expect(result).toMatchObject({
      overall: "applied",
      scans: [{ result: "existing" }, { result: "existing" }],
    })
    expect(applyDeps.append).toHaveBeenCalledTimes(1)
    expect(applyDeps.append).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ scanId: scanIds[0] })]),
      expect.objectContaining({ receiptHash: result.receiptHash })
    )
  })

  it("binds one evidence file digest to each exact scan", async () => {
    const parsed = parseTerminalCostDispositionReceipt(receipt())
    expect(() =>
      assertExpectedAzureResourceId(
        parsed,
        "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/other/providers/Microsoft.OperationalInsights/workspaces/unrelated"
      )
    ).toThrow(`unexpected Azure resource ID for ${scanIds[0]}`)
    expect(() =>
      assertExpectedAzureResourceId(parsed, parsed.scans[0].azureEvidence.resourceId)
    ).not.toThrow()
    const providerReceipt = parseTerminalCostDispositionReceipt({
      ...receipt(),
      scans: receipt().scans.map((scan) => ({
        ...scan,
        azureEvidence: { ...scan.azureEvidence, resourceId: azureProviderResourceId },
      })),
    })
    expect(() =>
      assertExpectedAzureResourceId(providerReceipt, azureProviderResourceId)
    ).not.toThrow()
    const files = new Map([
      ["/one", evidenceBytes(0)],
      ["/two", evidenceBytes(1)],
    ])
    await expect(
      verifyTerminalCostEvidenceFiles(
        parsed,
        [`${scanIds[0]}=/one`, `${scanIds[1]}=/two`],
        async (path) => files.get(path)!
      )
    ).resolves.toBeUndefined()
    await expect(
      verifyTerminalCostEvidenceFiles(
        parsed,
        [`${scanIds[0]}=/two`, `${scanIds[1]}=/one`],
        async (path) => files.get(path)!
      )
    ).rejects.toThrow(`does not match receipt for ${scanIds[0]}`)

    const nonzeroEvidence = Buffer.from(
      JSON.stringify(evidencePayload(0, { providerRequestCount: 1, providerCostUsd: 0.1 }))
    )
    const nonzeroReceipt = parseTerminalCostDispositionReceipt({
      ...receipt(),
      scans: receipt().scans.map((scan, index) =>
        index === 0
          ? {
              ...scan,
              azureEvidence: {
                ...scan.azureEvidence,
                evidenceSha256: createHash("sha256").update(nonzeroEvidence).digest("hex"),
              },
            }
          : scan
      ),
    })
    await expect(
      verifyTerminalCostEvidenceFiles(
        nonzeroReceipt,
        [`${scanIds[0]}=/nonzero`, `${scanIds[1]}=/two`],
        async (path) => (path === "/nonzero" ? nonzeroEvidence : files.get(path)!)
      )
    ).rejects.toThrow()
  })

  it("rejects an existing event whose atomic audit metadata mismatches", async () => {
    const parsed = parseTerminalCostDispositionReceipt(receipt())
    const current = {
      workspaceId: "workspace-1",
      target: { type: "REPO" },
      status: "FAILED",
      startedAt: new Date("2026-08-17T12:00:00.000Z"),
      endedAt: new Date("2026-08-17T12:10:00.000Z"),
      deletedAt: null,
      providerCostUsd: null,
      billedCostUsd: null,
      _count: { events: 1 },
    }
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: parsed.operator.userId,
          email: parsed.operator.email,
          emailVerified: true,
          twoFactorEnabled: true,
          platformRole: "PLATFORM_OPERATOR",
        }),
      },
      scan: { findUnique: vi.fn().mockResolvedValue(current) },
      scanEvent: {
        findUnique: vi.fn().mockResolvedValue({
          metadata: { receiptHash: terminalCostDispositionReceiptHash(parsed) },
        }),
      },
      platformAdminAudit: {
        findUnique: vi.fn().mockResolvedValue({
          actorUserId: parsed.operator.userId,
          sessionId: "offline-terminal-cost-review",
          action: "wrong.action",
          resourceType: "scan",
          resourceId: scanIds[0],
          metadata: { receiptHash: terminalCostDispositionReceiptHash(parsed) },
        }),
      },
    }
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx)
      ),
    }
    const dbDeps = createTerminalCostDispositionDbDeps(prisma as never)
    await expect(
      dbDeps.append([parsed.scans[0]], {
        receiptHash: terminalCostDispositionReceiptHash(parsed),
        reviewed: parsed,
      })
    ).rejects.toThrow("mismatched atomic audit")
  })
})
