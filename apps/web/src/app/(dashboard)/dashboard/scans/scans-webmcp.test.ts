import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerWebMcpTool, type WebMcpPageTool } from "@/lib/webmcp/register"
import { createWebMcpReceiptStore, type WebMcpReceiptStore } from "@/lib/webmcp/receipts"
import type { TargetItem } from "./scan-types"
import {
  createCheckSecurityScanHandler,
  createCheckSecurityScanTool,
  createPrepareSecurityScanTool,
  createRequestSecurityScanTool,
  resolveReviewOption,
  resolveVisibleTargetByName,
} from "./scans-webmcp.utils"

function target(partial: Partial<TargetItem> & { id: string; name: string }): TargetItem {
  return { type: "REPO", ...partial } as TargetItem
}

const abortSignal = new AbortController().signal

function okFetch(data: unknown) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, data }),
  })) as unknown as typeof fetch
}

describe("resolveVisibleTargetByName", () => {
  const targets = [
    target({ id: "t-1", name: "Storefront" }),
    target({ id: "t-2", name: "api" }),
    target({ id: "t-3", name: "API" }),
  ]

  it("matches the visible name case-insensitively and rejects ambiguity", () => {
    expect(resolveVisibleTargetByName(targets, "storefront").id).toBe("t-1")
    expect(() => resolveVisibleTargetByName(targets, "API")).toThrow(/Multiple targets/)
    expect(() => resolveVisibleTargetByName(targets, "missing")).toThrow(/No target named/)
    // Exact match only — substrings never resolve.
    expect(() => resolveVisibleTargetByName(targets, "store")).toThrow(/No target named/)
  })
})

describe("resolveReviewOption", () => {
  it("picks the requested available type, then the page selection, then the first", () => {
    const repo = target({ id: "t-1", name: "repo", type: "REPO" })
    expect(resolveReviewOption(repo, "DEEP_REVIEW", "CODE_REVIEW").id).toBe("DEEP_REVIEW")
    expect(resolveReviewOption(repo, undefined, "CODE_REVIEW").id).toBe("CODE_REVIEW")
    expect(resolveReviewOption(repo, undefined, "GONE")).toBeDefined()
  })

  it("refuses a review type the target cannot run today", () => {
    const apiNoSpec = target({ id: "t-2", name: "api", type: "API", apiSpecUrl: null })
    expect(() => resolveReviewOption(apiNoSpec, "API_DEEP", "API_SAFE")).toThrow(/not available/)
  })
})

describe("check_security_scan handler", () => {
  const targets = [
    target({ id: "t-1", name: "Storefront", type: "WEB_APP", url: "https://app.example.com" }),
  ]

  it("calls the shared eligibility contract with the page workspace — never agent input", async () => {
    const fetchFn = okFetch({ allowed: true, code: null, plan: "PRO", remainingMinutes: 120 })
    const handler = createCheckSecurityScanHandler({
      workspaceId: "ws-page",
      getTargets: () => targets,
      getSelectedPreset: () => "WEB_APP_SAFE",
      fetchFn: fetchFn as never,
    })

    const result = await handler({ targetName: "storefront" }, { signal: abortSignal })

    const [url, init] = vi.mocked(fetchFn).mock.calls[0]! as [string, RequestInit]
    expect((init.method ?? "GET").toUpperCase()).toBe("GET")
    const params = new URL(url, "http://app.test").searchParams
    expect(params.get("workspaceId")).toBe("ws-page")
    expect(params.get("targetId")).toBe("t-1")
    // URL reviews map depth to goal via the shared option policy
    // (SAFE → LAUNCH_REVIEW) — the tool sends what the composer would.
    expect(params.get("goal")).toBe("LAUNCH_REVIEW")
    expect(params.get("mode")).toBe("SAFE")
    expect(result).toMatchObject({
      allowed: true,
      plan: "PRO",
      remainingMinutes: 120,
      reviewType: { id: "WEB_APP_SAFE" },
      target: { name: "Storefront", type: "WEB_APP" },
    })
  })

  it("maps the requested review type to the option's goal and mode", async () => {
    const fetchFn = okFetch({ allowed: false, code: "DOMAIN_VERIFICATION_REQUIRED" })
    const handler = createCheckSecurityScanHandler({
      workspaceId: "ws-page",
      getTargets: () => targets,
      getSelectedPreset: () => "WEB_APP_SAFE",
      fetchFn: fetchFn as never,
    })

    await handler({ targetName: "Storefront", reviewType: "WEB_APP_DEEP" }, { signal: abortSignal })

    const [url] = vi.mocked(fetchFn).mock.calls[0]! as [string]
    const params = new URL(url, "http://app.test").searchParams
    expect(params.get("goal")).toBe("FULL_PENTEST")
    expect(params.get("mode")).toBe("DEEP")
  })

  it("returns an eligibility denial as a successful read", async () => {
    const fetchFn = okFetch({
      allowed: false,
      code: "NO_MINUTES_REMAINING",
      message: "Your agent-minute balance is exhausted.",
      plan: "FREE",
      remainingMinutes: 0,
    })
    const handler = createCheckSecurityScanHandler({
      workspaceId: "ws-page",
      getTargets: () => targets,
      getSelectedPreset: () => "WEB_APP_SAFE",
      fetchFn: fetchFn as never,
    })

    const result = await handler({ targetName: "Storefront" }, { signal: abortSignal })

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("NO_MINUTES_REMAINING")
    expect(result.remainingMinutes).toBe(0)
  })

  it("throws only on transport/API failures, never mutating anything", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: "Target not found in this workspace" } }),
    })) as unknown as typeof fetch
    const handler = createCheckSecurityScanHandler({
      workspaceId: "ws-page",
      getTargets: () => targets,
      getSelectedPreset: () => "WEB_APP_SAFE",
      fetchFn: fetchFn as never,
    })

    await expect(handler({ targetName: "Storefront" }, { signal: abortSignal })).rejects.toThrow(
      "Target not found in this workspace"
    )
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]! as [string, RequestInit]
    expect(url.startsWith("/api/scans/eligibility")).toBe(true)
    expect(init.body).toBeUndefined()
  })

  it("returns the full advisory: blockers and limitations travel with the verdict", async () => {
    const fetchFn = okFetch({
      allowed: false,
      code: "NO_MINUTES_REMAINING",
      message: "Your agent-minute balance is exhausted.",
      plan: "FREE",
      remainingMinutes: 0,
      blockers: [
        { code: "NO_MINUTES_REMAINING", message: "Your agent-minute balance is exhausted." },
        { code: "SCAN_WORKFLOW_UNAVAILABLE", message: "Workflow unavailable." },
      ],
      limitations: ["Immutable refs resolve only at submission."],
    })
    const handler = createCheckSecurityScanHandler({
      workspaceId: "ws-page",
      getTargets: () => targets,
      getSelectedPreset: () => "WEB_APP_SAFE",
      fetchFn: fetchFn as never,
    })

    const result = await handler({ targetName: "Storefront" }, { signal: abortSignal })

    expect(result.allowed).toBe(false)
    expect(result.blockers).toEqual([
      { code: "NO_MINUTES_REMAINING", message: "Your agent-minute balance is exhausted." },
      { code: "SCAN_WORKFLOW_UNAVAILABLE", message: "Workflow unavailable." },
    ])
    expect(result.limitations).toEqual(["Immutable refs resolve only at submission."])
  })
})

describe("scans page tool registrations", () => {
  const targets = [
    target({ id: "t-1", name: "Storefront", type: "WEB_APP", url: "https://app.example.com" }),
  ]
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

  it("request_security_scan posts the page workspace and carries safe receipt refs + recovery link", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { id: "scan-9", operationId: "op-9" } }),
    })
    const { store, tool } = register(
      createRequestSecurityScanTool({
        workspaceId: "ws-page",
        getTargets: () => targets,
        getSelectedPreset: () => "WEB_APP_SAFE",
      })
    )

    const result = (await tool.execute(
      { requestId: "req-1", targetName: "Storefront" },
      { signal: new AbortController().signal }
    )) as { ok: boolean; output: Record<string, unknown> }

    expect(result.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe("/api/scans")
    expect(init.method).toBe("POST")
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    // The workspace comes from the page — never from agent input.
    expect(body.workspaceId).toBe("ws-page")
    expect(body.targetId).toBe("t-1")
    expect(init.headers).toMatchObject({ "Idempotency-Key": "req-1" })

    const receipt = store.getSnapshot().latest
    expect(receipt?.status).toBe("completed")
    expect(receipt?.references).toEqual({
      requestId: "req-1",
      scanId: "scan-9",
      operationId: "op-9",
    })
    expect(receipt?.href).toBe("/dashboard/scans/scan-9")
  })

  it("request_security_scan rejects caller-supplied tenancy and foreign ids", async () => {
    const { tool } = register(
      createRequestSecurityScanTool({
        workspaceId: "ws-page",
        getTargets: () => targets,
        getSelectedPreset: () => "WEB_APP_SAFE",
      })
    )
    for (const key of ["workspaceId", "workspace", "userId", "user", "targetId", "evidence"]) {
      const result = (await tool.execute(
        { requestId: "req-1", targetName: "Storefront", [key]: "foreign" },
        { signal: new AbortController().signal }
      )) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain(`"${key}"`)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("request_security_scan abort during submission reports an uncertain outcome, never a false cancel", async () => {
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          )
        })
    )
    const { store, tool } = register(
      createRequestSecurityScanTool({
        workspaceId: "ws-page",
        getTargets: () => targets,
        getSelectedPreset: () => "WEB_APP_SAFE",
      })
    )
    const controller = new AbortController()
    const pending = tool.execute(
      { requestId: "req-1", targetName: "Storefront" },
      { signal: controller.signal }
    )
    controller.abort()
    const result = (await pending) as {
      ok: boolean
      cancelled?: boolean
      uncertain?: boolean
      error?: string
    }

    expect(result.ok).toBe(false)
    expect(result.uncertain).toBe(true)
    expect(result.error).toMatch(/uncertain/i)
    expect(result.error).toMatch(/poll|status|dashboard/i)
    expect(result.error).not.toMatch(/scan was cancelled/i)
    expect(store.getSnapshot().latest?.summary).toMatch(/uncertain/i)
  })

  it("request_security_scan description discloses durable work and allowance", () => {
    const { tool } = register(
      createRequestSecurityScanTool({
        workspaceId: "ws-page",
        getTargets: () => targets,
        getSelectedPreset: () => "WEB_APP_SAFE",
      })
    )
    expect(tool.description.length).toBeLessThanOrEqual(150)
    expect(tool.description).toMatch(/durable/i)
    expect(tool.description).toMatch(/sponsoring-account allowance|agent-minute allowance/i)
  })

  it("check_security_scan returns the eligibility advisory including blockers", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          allowed: false,
          code: "DOMAIN_VERIFICATION_REQUIRED",
          message: "Verify control of this domain once to enable engine-backed reviews.",
          plan: "PRO",
          remainingMinutes: 120,
          blockers: [
            {
              code: "DOMAIN_VERIFICATION_REQUIRED",
              message: "Verify control of this domain once to enable engine-backed reviews.",
            },
          ],
        },
      }),
    })
    const { store, tool } = register(
      createCheckSecurityScanTool({
        workspaceId: "ws-page",
        getTargets: () => targets,
        getSelectedPreset: () => "WEB_APP_SAFE",
      })
    )
    const result = (await tool.execute(
      { targetName: "Storefront" },
      { signal: new AbortController().signal }
    )) as { ok: boolean; output: Record<string, unknown> }

    expect(result.ok).toBe(true)
    expect(result.output).toMatchObject({
      allowed: false,
      code: "DOMAIN_VERIFICATION_REQUIRED",
      plan: "PRO",
      remainingMinutes: 120,
      blockers: [{ code: "DOMAIN_VERIFICATION_REQUIRED" }],
      target: { name: "Storefront" },
      reviewType: { id: "WEB_APP_SAFE" },
    })
    const [url] = fetchMock.mock.calls[0]! as [string]
    expect(url.startsWith("/api/scans/eligibility?")).toBe(true)

    // The receipt carries a safe reference set + an in-dashboard recovery link.
    const receipt = store.getSnapshot().latest
    expect(receipt?.references).toEqual({
      target: "Storefront",
      reviewType: "WEB_APP_SAFE",
    })
    expect(receipt?.href).toBe("/dashboard/scans")
  })

  it("check_security_scan rejects caller-supplied tenancy keys", async () => {
    const { tool } = register(
      createCheckSecurityScanTool({
        workspaceId: "ws-page",
        getTargets: () => targets,
        getSelectedPreset: () => "WEB_APP_SAFE",
      })
    )
    const result = (await tool.execute(
      { targetName: "Storefront", userId: "other" },
      { signal: new AbortController().signal }
    )) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('"userId"')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("prepare_security_scan keeps its contract: fills the form, never submits", async () => {
    const setters = {
      setSelectedTarget: vi.fn(),
      setSelectedPreset: vi.fn(),
      setShowCreate: vi.fn(),
      setModeResetNotice: vi.fn(),
    }
    const { store, tool } = register(
      createPrepareSecurityScanTool({
        getTargets: () => targets,
        getSelectedPreset: () => "WEB_APP_SAFE",
        ...setters,
      })
    )
    const result = (await tool.execute(
      { targetName: "Storefront" },
      { signal: new AbortController().signal }
    )) as { ok: boolean; output: Record<string, unknown> }

    expect(result.ok).toBe(true)
    expect(result.output).toMatchObject({
      prepared: true,
      target: { name: "Storefront", type: "WEB_APP" },
      reviewType: { id: "WEB_APP_SAFE" },
    })
    expect(result.output.nextStep).toMatch(/Start/i)
    expect(setters.setSelectedTarget).toHaveBeenCalledWith("t-1")
    expect(setters.setShowCreate).toHaveBeenCalledWith(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.getSnapshot().latest?.humanConfirmationRequired).toBe(true)
  })

  it("the composer visibly discloses durable work and sponsoring-account allowance next to Start", () => {
    // The disclosure lives in the sheet's persistent description — always
    // rendered while the Start button is visible, not behind the 150-char
    // tool-description budget.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const src = readFileSync(new URL("./create-scan-sheet.tsx", import.meta.url), "utf8")
    expect(src).toMatch(/durable/i)
    expect(src).toMatch(/sponsoring account|agent-minute allowance/i)
  })

  it("page tools re-register cleanly on workspace change", () => {
    const first = register(
      createCheckSecurityScanTool({
        workspaceId: "ws-a",
        getTargets: () => targets,
        getSelectedPreset: () => "WEB_APP_SAFE",
      })
    )
    first.cleanup()
    // Route/workspace change: the same tool name registers for the new page.
    const second = register(
      createCheckSecurityScanTool({
        workspaceId: "ws-b",
        getTargets: () => targets,
        getSelectedPreset: () => "WEB_APP_SAFE",
      })
    )
    expect(registerTool).toHaveBeenCalledTimes(2)
    second.cleanup()
  })
})
