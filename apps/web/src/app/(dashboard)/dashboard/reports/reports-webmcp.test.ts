import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerWebMcpTool, type WebMcpPageTool } from "@/lib/webmcp/register"
import { createWebMcpReceiptStore, type WebMcpReceiptStore } from "@/lib/webmcp/receipts"
import { createReviewScanReportTool } from "./reports-webmcp.utils"
import type { ReportItem } from "./reports-model"

const abortSignal = new AbortController().signal

function reportRow(partial: Partial<ReportItem> & { id: string }): ReportItem {
  return {
    title: "Quarterly assurance",
    type: "executive",
    status: "generated",
    format: "html",
    shareExpiresAt: null,
    revokedAt: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    scanId: "scan-1",
    ...partial,
  }
}

function reportDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    title: "LyraShield Security Assurance Report",
    type: "executive",
    status: "generated",
    format: "html",
    shareUrl: "/reports/shared/r-1",
    shareExpiresAt: "2026-02-01T00:00:00.000Z",
    revokedAt: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    scanSummary: {
      scanId: "scan-1",
      status: "COMPLETED",
      summary: "Scan completed with findings.",
      targetName: "Private target",
      findingsCount: 4,
      findingsBySeverity: { HIGH: 1, MEDIUM: 3 },
    },
    assurance: {
      verdict: "NEEDS_ATTENTION",
      score: 72,
      grade: "B",
      narrative: "A narrative that stays server-side.",
      verifiedCount: 2,
      fixedCount: 1,
      retestSummary: { passed: 2, failed: 0, pending: 1 },
      findingsByStatus: { OPEN: 3, FIXED: 1 },
      findingsByCategory: { injection: 2 },
      ageBuckets: {},
      scoreTrend: [],
      priorityActions: [],
      methodology: [],
    },
    webMcpAssurance: null,
    ...overrides,
  }
}

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
  }
}

describe("review_scan_report registration", () => {
  let registerTool: ReturnType<typeof vi.fn>
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    registerTool = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).document = { modelContext: { registerTool } }
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).document
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  interface Registered {
    store: WebMcpReceiptStore
    tool: {
      name: string
      description: string
      execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>
    }
    cleanup: () => void
  }

  function register<T extends Record<string, unknown>>(definition: WebMcpPageTool<T>): Registered {
    const store = createWebMcpReceiptStore()
    const cleanup = registerWebMcpTool({ ...definition, receiptStore: store })
    cleanups.push(cleanup)
    const tool = registerTool.mock.calls.at(-1)?.[0] as Registered["tool"]
    return { store, tool, cleanup }
  }

  const rows = [reportRow({ id: "r-1" }), reportRow({ id: "r-2", scanId: "scan-2" })]

  function definition(reports: ReportItem[] = rows) {
    return createReviewScanReportTool({
      workspaceId: "ws-1",
      getReports: () => reports,
    })
  }

  it("resolves a visible report and returns bounded metadata + summary via GET only", async () => {
    fetchMock.mockResolvedValue(jsonResponse(reportDetail()))
    const { tool } = register(definition())

    const result = (await tool.execute({ reportId: "r-1" }, { signal: abortSignal })) as {
      ok: boolean
      output: Record<string, unknown>
    }

    expect(result.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe("/api/reports/r-1?workspaceId=ws-1")
    expect((init?.method ?? "GET").toUpperCase()).toBe("GET")
    expect(init?.body).toBeUndefined()
    // No POST was ever issued — reading never creates a report or a link.
    expect(fetchMock).toHaveBeenCalledTimes(1)

    expect(result.output).toMatchObject({
      reportId: "r-1",
      title: "Quarterly assurance",
      type: "executive",
      status: "generated",
      format: "html",
      shared: true,
      shareExpiresAt: "2026-02-01T00:00:00.000Z",
      scan: {
        scanId: "scan-1",
        status: "COMPLETED",
        findingsCount: 4,
        findingsBySeverity: { HIGH: 1, MEDIUM: 3 },
      },
      assurance: {
        verdict: "NEEDS_ATTENTION",
        score: 72,
        grade: "B",
        verifiedCount: 2,
        fixedCount: 1,
        retestSummary: { passed: 2, failed: 0, pending: 1 },
      },
    })
  })

  it("resolves by the row's scan id and defaults to the newest visible report", async () => {
    fetchMock.mockResolvedValue(jsonResponse(reportDetail({ id: "r-2" })))
    const { tool } = register(definition())

    const byScan = (await tool.execute({ scanId: "scan-2" }, { signal: abortSignal })) as {
      ok: boolean
      output: { reportId: string }
    }
    expect(byScan.ok).toBe(true)
    expect(byScan.output.reportId).toBe("r-2")

    const latest = (await tool.execute({}, { signal: abortSignal })) as {
      ok: boolean
      output: { reportId: string }
    }
    expect(latest.ok).toBe(true)
    // No identifier → the newest visible row (rows[0]) is resolved.
    expect(latest.output.reportId).toBe("r-1")
  })

  it("rejects ids that are not visible on the page — before any fetch", async () => {
    const { tool } = register(definition())
    const result = (await tool.execute({ reportId: "r-999" }, { signal: abortSignal })) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/r-999/)
    expect(result.error).toMatch(/not (currently )?visible/i)
    expect(fetchMock).not.toHaveBeenCalled()

    const scanResult = (await tool.execute({ scanId: "scan-9" }, { signal: abortSignal })) as {
      ok: boolean
      error?: string
    }
    expect(scanResult.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("requires reportId and scanId to name the same visible report when both are given", async () => {
    fetchMock.mockResolvedValue(jsonResponse(reportDetail()))
    const { tool } = register(definition())
    const mismatch = (await tool.execute(
      { reportId: "r-1", scanId: "scan-2" },
      { signal: abortSignal }
    )) as { ok: boolean; error?: string }
    expect(mismatch.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()

    const match = (await tool.execute(
      { reportId: "r-1", scanId: "scan-1" },
      { signal: abortSignal }
    )) as { ok: boolean }
    expect(match.ok).toBe(true)
  })

  it("errors cleanly when no reports are visible", async () => {
    const { tool } = register(definition([]))
    const result = (await tool.execute({}, { signal: abortSignal })) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no reports/i)
  })

  it("rejects caller-supplied tenancy and foreign resource keys", async () => {
    const { tool } = register(definition())
    for (const key of ["workspaceId", "workspace", "userId", "user", "targetId", "evidence"]) {
      const result = (await tool.execute(
        { reportId: "r-1", [key]: "injected" },
        { signal: abortSignal }
      )) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain(`"${key}"`)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("never returns storage URIs, signed URLs, share links or raw report content", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        reportDetail({
          // Hostile-ish payload fields the projection must drop entirely.
          storageUri: "s3://evidence-bucket/report.pdf?sig=x",
          contentJson: { secret: "material" },
          shareUrl: "/reports/shared/r-1?token=topsecret",
          scanSummary: {
            scanId: "scan-1",
            status: "COMPLETED",
            summary: "Evidence at s3://bucket/key and https://signed.example/x?token=abc",
            targetName: "Private target",
            findingsCount: 1,
            findingsBySeverity: { LOW: 1 },
          },
        })
      )
    )
    const { tool } = register(definition())
    const result = (await tool.execute({ reportId: "r-1" }, { signal: abortSignal })) as {
      ok: boolean
      output: Record<string, unknown>
    }

    expect(result.ok).toBe(true)
    const serialized = JSON.stringify(result.output)
    expect("shareUrl" in result.output).toBe(false)
    expect("storageUri" in result.output).toBe(false)
    expect("contentJson" in result.output).toBe(false)
    expect("narrative" in result.output).toBe(false)
    expect(serialized).not.toContain("token=topsecret")
    expect(serialized).not.toContain("s3://")
    expect(serialized).not.toContain("signed.example")
    expect(serialized).not.toContain("/reports/shared")
  })

  it("includes bounded launch provenance only for launch_readiness reports", async () => {
    const launchRow = reportRow({
      id: "r-launch",
      type: "launch_readiness",
      provenance: {
        gateVerdictId: "gv-1",
        verdictChecksum: "c".repeat(64),
        assessmentVersion: 3,
        assessedIdentity: { kind: "COMMIT", value: "a".repeat(40) },
        assessedAt: "2026-01-01T00:00:00.000Z",
        issuedAt: "2026-01-02T00:00:00.000Z",
        applicabilityCheckedAt: "2026-01-02T00:00:00.000Z",
        applicability: "applicable",
        reasonCodes: ["GATE_SCOPE_PARTIAL"],
        historicalState: "READY",
        effectiveState: null,
      },
    })
    fetchMock.mockResolvedValue(
      jsonResponse(
        reportDetail({
          id: "r-launch",
          type: "launch_readiness",
          launchReport: {
            verdictLabel: "Ready to launch",
            stale: false,
            provenance: launchRow.provenance,
          },
        })
      )
    )
    const { tool } = register(definition([launchRow]))
    const result = (await tool.execute({ reportId: "r-launch" }, { signal: abortSignal })) as {
      ok: boolean
      output: { launch?: Record<string, unknown> }
    }

    expect(result.ok).toBe(true)
    expect(result.output.launch).toMatchObject({
      verdictLabel: "Ready to launch",
      stale: false,
      applicability: "applicable",
      historicalState: "READY",
      assessedIdentity: { kind: "COMMIT", value: "a".repeat(40) },
    })
  })

  it("receipt carries the report reference and the in-dashboard reports link", async () => {
    fetchMock.mockResolvedValue(jsonResponse(reportDetail()))
    const { store, tool } = register(definition())
    await tool.execute({ reportId: "r-1" }, { signal: abortSignal })

    const receipt = store.getSnapshot().latest
    expect(receipt?.status).toBe("completed")
    expect(receipt?.references).toEqual({ reportId: "r-1", scanId: "scan-1" })
    expect(receipt?.href).toBe("/dashboard/reports")
  })

  it("reports cancellation when the caller aborts mid-read", async () => {
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          )
        })
    )
    const { store, tool } = register(definition())
    const controller = new AbortController()
    const pending = tool.execute({ reportId: "r-1" }, { signal: controller.signal })
    controller.abort()
    const result = (await pending) as { ok: boolean }
    expect(result.ok).toBe(false)
    expect(store.getSnapshot().latest?.status).toBe("cancelled")
  })
})
