import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerWebMcpTool, type WebMcpPageTool } from "@/lib/webmcp/register"
import { createWebMcpReceiptStore, type WebMcpReceiptStore } from "@/lib/webmcp/receipts"
import { SCAN_QUALITY_SURFACE_VERSION } from "@lyrashield/types"
import { buildScanProgressOutput, createReviewScanProgressTool } from "./scan-detail-webmcp.utils"
import type { ScanPollData } from "./scan-detail-types"

const abortSignal = new AbortController().signal

function pollData(partial: Partial<ScanPollData> = {}): ScanPollData {
  return {
    id: "scan-1",
    workspaceId: "ws-1",
    status: "RUNNING",
    goal: "LAUNCH_REVIEW",
    mode: "STANDARD",
    triggerType: "MANUAL",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    summary: null,
    errorCategory: null,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    events: [
      {
        id: "e-1",
        stage: "preflight",
        level: "info",
        message: "[preflight] Setup checks passed",
        createdAt: "2026-01-01T00:00:10.000Z",
      },
      {
        id: "e-2",
        stage: "running",
        level: "info",
        message: "[running] Crawling target",
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    ],
    coverageReceipts: [
      { scanner: "sca", controlId: "sca-1", status: "COMPLETED" },
      { scanner: "secrets", controlId: "sec-1", status: "COMPLETED" },
    ],
    resultManifest: { checksum: "abc123" },
    ...partial,
  }
}

function qualitySurface() {
  return {
    version: SCAN_QUALITY_SURFACE_VERSION,
    facts: {
      scanStatus: "RUNNING",
      scanMode: "STANDARD",
      deterministicRun: false,
      durationMs: null,
      llmRequests: 5,
      findings: {
        total: 7,
        byVerificationStatus: { DETECTED: 7 },
        bySeverity: { HIGH: 2, MEDIUM: 5 },
        validatedCount: 0,
        verifiedCount: 1,
        nonConclusiveCount: 6,
      },
      coverage: {
        receiptsTotal: 2,
        byStatus: { COMPLETED: 2 },
        byScanner: { sca: 1, secrets: 1 },
        engineDeclaredReceipts: 0,
        connectorReceipts: 0,
      },
      evidence: {
        manifestPresent: true,
        manifestChecksum: "abc123",
        ingestionWarningCount: 0,
        attachmentCount: 1,
      },
    },
    estimates: {
      assessedReceiptRatio: { kind: "heuristic", value: 1, basis: "test" },
      verifiedFindingRatio: { kind: "heuristic", value: 0.14, basis: "test" },
    },
    parity: {},
    surfaceChecksum: "deadbeef",
  }
}

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
  }
}

describe("buildScanProgressOutput", () => {
  it("reports status, derived stage, steps, elapsed and counts — with explicit absences", () => {
    const output = buildScanProgressOutput({
      poll: pollData(),
      quality: qualitySurface() as never,
      now: new Date("2026-01-01T00:05:00.000Z").getTime(),
    })

    expect(output.scanId).toBe("scan-1")
    expect(output.status).toBe("RUNNING")
    expect(output.currentStage).toBe("Crawling target")
    expect(output.steps).toEqual([
      { label: "Setup check", state: "done" },
      { label: "Scanning", state: "active" },
    ])
    expect(output.elapsedSeconds).toBe(300)
    expect(output.counts).toMatchObject({
      events: 2,
      coverageReceipts: 2,
      findings: 7,
      verifiedFindings: 1,
    })
    expect(output.evidence).toMatchObject({
      manifestPresent: true,
      manifestChecksum: "abc123",
      ingestionWarnings: 0,
      attachments: 1,
    })
  })

  it("never fabricates percent-complete or ETA — absent fields are reported absent", () => {
    const output = buildScanProgressOutput({
      poll: pollData(),
      quality: qualitySurface() as never,
      now: new Date("2026-01-01T00:05:00.000Z").getTime(),
    })
    const serialized = JSON.stringify(output)

    expect("percentComplete" in output).toBe(false)
    expect("eta" in output).toBe(false)
    expect("etaSeconds" in output).toBe(false)
    expect(output.notReported).toEqual(expect.arrayContaining(["percentComplete", "etaSeconds"]))
    // The only estimate carried is the page's own static per-mode estimate.
    expect(output.estimatedMinutes).toEqual({ low: 12, high: 23 })
    expect(serialized).not.toMatch(/"eta"\s*:/)
    expect(serialized).not.toMatch(/"percent(Complete)?"\s*:/)
  })

  it("reports absent fields as null when timestamps or quality are unavailable", () => {
    const output = buildScanProgressOutput({
      poll: pollData({
        status: "QUEUED",
        startedAt: null,
        events: [],
        coverageReceipts: undefined,
      }),
      quality: null,
      now: Date.now(),
    })
    expect(output.elapsedSeconds).toBeNull()
    expect(output.counts.findings).toBeNull()
    expect(output.evidence?.ingestionWarnings).toBeNull()
    expect(output.evidence?.receiptsByStatus).toBeNull()
  })

  it("never reports an active phase after a scan has ended", () => {
    for (const status of ["FAILED", "CANCELLED", "TIMED_OUT", "PARTIAL", "STOPPED_BUDGET"]) {
      const output = buildScanProgressOutput({
        poll: pollData({ status, endedAt: "2026-01-01T00:05:00.000Z" }),
        quality: null,
      })
      expect(output.steps).toEqual([
        { label: "Setup check", state: "done" },
        { label: "Scanning", state: "stopped" },
      ])
    }

    const completed = buildScanProgressOutput({
      poll: pollData({ status: "COMPLETED", endedAt: "2026-01-01T00:05:00.000Z" }),
      quality: null,
    })
    expect(completed.steps.every((step) => step.state === "done")).toBe(true)
  })
})

describe("review_scan_progress registration", () => {
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

  function definition(scanId = "scan-1") {
    return createReviewScanProgressTool({
      workspaceId: "ws-1",
      getScanId: () => scanId,
    })
  }

  it("defaults to the displayed scan and reads the page's own poll + quality endpoints", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/quality")) return jsonResponse(qualitySurface())
      return jsonResponse(pollData())
    })
    const { tool } = register(definition())

    const result = (await tool.execute({}, { signal: abortSignal })) as {
      ok: boolean
      output: Record<string, unknown>
    }

    expect(result.ok).toBe(true)
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls.some((u) => u.startsWith("/api/scans/scan-1?workspaceId=ws-1"))).toBe(true)
    expect(urls.some((u) => u.startsWith("/api/scans/scan-1/quality?workspaceId=ws-1"))).toBe(true)
    // Read-only: no method/body ever goes out.
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect((init?.method ?? "GET").toUpperCase()).toBe("GET")
      expect(init?.body).toBeUndefined()
    }
    expect(result.output.status).toBe("RUNNING")
    expect(result.output.scanId).toBe("scan-1")
  })

  it("accepts the displayed scan id and rejects any other scan id", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/quality")) return jsonResponse(qualitySurface())
      return jsonResponse(pollData())
    })
    const { tool } = register(definition("scan-1"))

    const ok = (await tool.execute({ scanId: "scan-1" }, { signal: abortSignal })) as {
      ok: boolean
    }
    expect(ok.ok).toBe(true)

    const foreign = (await tool.execute({ scanId: "scan-999" }, { signal: abortSignal })) as {
      ok: boolean
      error?: string
    }
    expect(foreign.ok).toBe(false)
    expect(foreign.error).toMatch(/scan-999/)
    expect(foreign.error).toMatch(/not (the |currently )?(shown|visible|displayed)/i)

    // Only the successful first call fetched.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("rejects caller-supplied tenancy and foreign resource keys", async () => {
    const { tool } = register(definition())
    for (const key of ["workspaceId", "workspace", "userId", "user", "targetId", "evidence"]) {
      const result = (await tool.execute(
        { scanId: "scan-1", [key]: "injected" },
        { signal: abortSignal }
      )) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain(`"${key}"`)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("keeps the poll data honest when the quality surface is unavailable", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/quality")) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ success: false, error: { message: "boom" } }),
        }
      }
      return jsonResponse(pollData({ status: "COMPLETED", endedAt: "2026-01-01T00:10:00Z" }))
    })
    const { tool } = register(definition())

    const result = (await tool.execute({}, { signal: abortSignal })) as {
      ok: boolean
      output: {
        status: string
        counts: { findings: number | null }
        evidence: unknown
        notReported: string[]
      }
    }

    expect(result.ok).toBe(true)
    expect(result.output.status).toBe("COMPLETED")
    // Findings/quality counts are absent, not fabricated.
    expect(result.output.counts.findings).toBeNull()
  })

  it("reports cancellation when the caller aborts mid-poll", async () => {
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
    const pending = tool.execute({}, { signal: controller.signal })
    controller.abort()
    const result = (await pending) as { ok: boolean; cancelled?: boolean }

    expect(result.ok).toBe(false)
    expect(store.getSnapshot().latest?.status).toBe("cancelled")
  })

  it("receipt carries the scan reference and an in-dashboard recovery link", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/quality")) return jsonResponse(qualitySurface())
      return jsonResponse(pollData())
    })
    const { store, tool } = register(definition())
    await tool.execute({}, { signal: abortSignal })

    const receipt = store.getSnapshot().latest
    expect(receipt?.status).toBe("completed")
    expect(receipt?.references).toEqual({ scanId: "scan-1" })
    expect(receipt?.href).toBe("/dashboard/scans/scan-1")
  })

  it("tool output never contains storage URIs or signed URLs", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/quality")) return jsonResponse(qualitySurface())
      return jsonResponse(
        pollData({
          summary: "s3://bucket/evidence/enc?sig=abc",
          errorMessage: "see https://signed-url.example/x?token=sekret",
        })
      )
    })
    const { tool } = register(definition())
    const result = (await tool.execute({}, { signal: abortSignal })) as {
      ok: boolean
      output: Record<string, unknown>
    }

    // The output projection must never surface the raw summary/error text —
    // only category, never payloads that could embed locations or secrets.
    const serialized = JSON.stringify(result.output)
    expect(serialized).not.toContain("s3://")
    expect(serialized).not.toContain("token=sekret")
    expect(serialized).not.toContain("signed-url.example")
  })
})
