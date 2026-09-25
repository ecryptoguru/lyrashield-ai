import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerWebMcpTool, type WebMcpPageTool } from "@/lib/webmcp/register"
import { createWebMcpReceiptStore, type WebMcpReceiptStore } from "@/lib/webmcp/receipts"
import type { FindingListItem, SortMode } from "./findings-client"
import {
  createReviewFindingsTool,
  runFindingsWebMcpUndo,
  type FindingsWebMcpUndoState,
} from "./findings-webmcp.utils"

const abortSignal = new AbortController().signal

function finding(partial: Partial<FindingListItem> & { id: string }): FindingListItem {
  return {
    title: "Finding",
    severity: "HIGH",
    status: "OPEN",
    verified: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  } as FindingListItem
}

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
  }
}

describe("review_findings registration", () => {
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

  function makeDeps(overrides: Partial<Parameters<typeof createReviewFindingsTool>[0]> = {}) {
    const visible = [
      finding({ id: "f-1", title: "SQL injection", severity: "CRITICAL" }),
      finding({ id: "f-2", title: "Weak TLS", severity: "MEDIUM" }),
    ]
    return {
      workspaceId: "ws-1",
      getFindings: () => visible,
      getFilter: () => "OPEN",
      getSortMode: () => "priority" as SortMode,
      setSortMode: vi.fn(),
      setSelectedFinding: vi.fn(),
      updateQueryParams: vi.fn(),
      applyFilter: vi.fn(async () => visible),
      setUndoState: vi.fn(),
      ...overrides,
    }
  }

  it("reports the current page view — filter, sort and visible count", async () => {
    const deps = makeDeps()
    const { tool, cleanup } = register(createReviewFindingsTool(deps))
    const result = (await tool.execute({}, { signal: abortSignal })) as {
      ok: boolean
      output: Record<string, unknown>
    }
    expect(result.ok).toBe(true)
    expect(result.output).toMatchObject({
      filter: "OPEN",
      sort: "priority",
      visibleCount: 2,
      explanation: null,
    })
    expect(deps.applyFilter).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    cleanup()
  })

  it("applies a filter change through the page path and captures the prior view for undo", async () => {
    const deps = makeDeps()
    const { tool, cleanup } = register(createReviewFindingsTool(deps))

    const result = (await tool.execute(
      { filter: "VERIFIED", sort: "severity" },
      { signal: abortSignal }
    )) as { ok: boolean; output: Record<string, unknown> }

    expect(result.ok).toBe(true)
    expect(result.output).toMatchObject({ filter: "VERIFIED", sort: "severity" })
    // The page's own apply path is used — never a direct fetch or state hack.
    // (The signal is the registration's execution signal linked to the caller's.)
    const applyArgs = vi.mocked(deps.applyFilter).mock.calls[0]
    expect(applyArgs?.[0]).toBe("VERIFIED")
    expect(applyArgs?.[1]).toBe("severity")
    expect(applyArgs?.[2]).toBeInstanceOf(AbortSignal)
    expect(deps.setUndoState).toHaveBeenCalledWith({ filter: "OPEN", sort: "priority" })
    cleanup()
  })

  it("captures undo state on a sort-only change without refetching", async () => {
    const deps = makeDeps()
    const { tool, cleanup } = register(createReviewFindingsTool(deps))
    await tool.execute({ sort: "severity" }, { signal: abortSignal })

    expect(deps.applyFilter).not.toHaveBeenCalled()
    expect(deps.setSortMode).toHaveBeenCalledWith("severity")
    expect(deps.updateQueryParams).toHaveBeenCalledWith({ filter: "OPEN", sort: "severity" })
    expect(deps.setUndoState).toHaveBeenCalledWith({ filter: "OPEN", sort: "priority" })
    cleanup()
  })

  it("undo round-trip restores the prior filter through the same page path", async () => {
    let filter = "OPEN"
    const deps = makeDeps({ getFilter: () => filter })
    const { tool, cleanup } = register(createReviewFindingsTool(deps))

    // Change filter+sort → the tool captures the prior state for undo.
    await tool.execute({ filter: "VERIFIED", sort: "severity" }, { signal: abortSignal })
    filter = "VERIFIED"
    const undo = vi.mocked(deps.setUndoState).mock.calls[0]?.[0] as FindingsWebMcpUndoState
    expect(undo).toEqual({ filter: "OPEN", sort: "priority" })

    // The drawer undo callback restores via the same apply path.
    const undoDeps = { ...deps, getFilter: () => filter }
    await runFindingsWebMcpUndo(undo, undoDeps)
    expect(deps.applyFilter).toHaveBeenLastCalledWith("OPEN", "priority")
    expect(deps.setSelectedFinding).toHaveBeenCalledWith(null)
    expect(deps.setUndoState).toHaveBeenLastCalledWith(null)
    cleanup()
  })

  it("undo with an unchanged filter skips the refetch and restores sort only", async () => {
    const deps = makeDeps()
    await runFindingsWebMcpUndo({ filter: "OPEN", sort: "severity" }, deps)
    expect(deps.applyFilter).not.toHaveBeenCalled()
    expect(deps.setSortMode).toHaveBeenCalledWith("severity")
    expect(deps.updateQueryParams).toHaveBeenCalledWith({ filter: "OPEN", sort: "severity" })
    expect(deps.setSelectedFinding).toHaveBeenCalledWith(null)
    expect(deps.setUndoState).toHaveBeenCalledWith(null)
  })

  it("is a no-op when no prior view was captured", async () => {
    const deps = makeDeps()
    await runFindingsWebMcpUndo(null, deps)
    expect(deps.applyFilter).not.toHaveBeenCalled()
    expect(deps.setSortMode).not.toHaveBeenCalled()
    expect(deps.setUndoState).not.toHaveBeenCalled()
  })

  it("explains a visible finding through the page's detail read and selects it", async () => {
    const deps = makeDeps()
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: "f-1",
        title: "SQL injection",
        summary: "User input reaches a query.",
        plainLanguage: {
          title: "SQL injection",
          whatItIs: "Unsafe query construction",
          whyItMatters: "Attackers read or modify data",
          howToFix: "Parameterize queries",
          difficulty: "MEDIUM",
          estimatedTimeToFix: "1-2 days",
        },
      })
    )
    const { tool, cleanup } = register(createReviewFindingsTool(deps))
    const result = (await tool.execute({ findingId: "f-1" }, { signal: abortSignal })) as {
      ok: boolean
      output: { visibleCount: number; explanation: Record<string, unknown> }
    }

    expect(result.ok).toBe(true)
    const [url] = fetchMock.mock.calls[0]! as [string]
    expect(url).toBe("/api/findings/f-1?workspaceId=ws-1")
    expect(deps.setSelectedFinding).toHaveBeenCalledWith(expect.objectContaining({ id: "f-1" }))
    expect(result.output.explanation).toMatchObject({
      title: "SQL injection",
      summary: "User input reaches a query.",
      untrustedContent: true,
      plainLanguage: { howToFix: "Parameterize queries" },
    })
    cleanup()
  })

  it("rejects a finding id that is not currently visible — before any fetch", async () => {
    const deps = makeDeps()
    const { tool, cleanup } = register(createReviewFindingsTool(deps))
    const result = (await tool.execute({ findingId: "f-99" }, { signal: abortSignal })) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/f-99/)
    expect(result.error).toMatch(/not (currently )?visible/i)
    expect(fetchMock).not.toHaveBeenCalled()
    cleanup()
  })

  it("rejects invalid filter and sort values the page does not offer", async () => {
    const deps = makeDeps()
    const { tool, cleanup } = register(createReviewFindingsTool(deps))
    const badFilter = (await tool.execute({ filter: "OWNED" }, { signal: abortSignal })) as {
      ok: boolean
      error?: string
    }
    expect(badFilter.ok).toBe(false)
    // Out-of-enum input is rejected by the strict input schema before the handler.
    expect(badFilter.error).toContain("Invalid enum value")
    const badSort = (await tool.execute({ sort: "alphabetical" }, { signal: abortSignal })) as {
      ok: boolean
      error?: string
    }
    expect(badSort.ok).toBe(false)
    expect(badSort.error).toContain("Invalid enum value")
    cleanup()
  })

  it("rejects caller-supplied tenancy and foreign resource keys", async () => {
    const deps = makeDeps()
    const { tool, cleanup } = register(createReviewFindingsTool(deps))
    for (const key of ["workspaceId", "workspace", "userId", "user", "targetId", "evidence"]) {
      const result = (await tool.execute({ [key]: "x" }, { signal: abortSignal })) as {
        ok: boolean
        error?: string
      }
      expect(result.ok).toBe(false)
      expect(result.error).toContain(`"${key}"`)
    }
    expect(deps.applyFilter).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    cleanup()
  })
})
