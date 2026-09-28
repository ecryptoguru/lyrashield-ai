import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ScanItem } from "./scan-types"

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
const apiGetPaginated = vi.hoisted(() => vi.fn())

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => {
    const index = hooks.cursor++
    hooks.values[index] ??= { current: initial }
    return hooks.values[index]
  },
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] =
          typeof value === "function"
            ? (value as (previous: unknown) => unknown)(hooks.values[index])
            : value
      },
    ]
  },
}))
vi.mock("@/lib/api-client", () => ({ apiGetPaginated, apiDelete: vi.fn(), apiPost: vi.fn() }))
vi.mock("./use-active-scans-polling", () => ({ useActiveScansPolling: () => {} }))

import { useScanListState } from "./use-scan-list-state"

function scan(id: string): ScanItem {
  return {
    id,
    status: "COMPLETED",
    goal: "TEST_APP",
    mode: "SAFE",
    triggerType: "MANUAL",
    startedAt: null,
    endedAt: null,
    summary: null,
    errorCategory: null,
    errorMessage: null,
    target: null,
    createdAt: "2026-09-01T00:00:00.000Z",
  }
}

function deferredPage() {
  let resolve!: (page: { items: ScanItem[]; nextCursor: string | null }) => void
  let reject!: (error: Error) => void
  const promise = new Promise<{ items: ScanItem[]; nextCursor: string | null }>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function RenderList() {
  return useScanListState({
    workspaceId: "workspace-1",
    initialData: [scan("initial")],
    initialNextCursor: "old-cursor",
    initialTargetFilter: "",
    initialStateFilter: "ALL",
    setError: vi.fn(),
    setErrorCode: vi.fn(),
  })
}

function renderList() {
  hooks.cursor = 0
  return RenderList()
}

describe("scan list request ordering", () => {
  beforeEach(() => {
    hooks.values = []
    hooks.cursor = 0
    apiGetPaginated.mockReset()
  })

  it("keeps the newest filter result and its cursor when an older request resolves last", async () => {
    const oldFilter = deferredPage()
    const newFilter = deferredPage()
    apiGetPaginated.mockReturnValueOnce(oldFilter.promise).mockReturnValueOnce(newFilter.promise)

    renderList().handleTargetFilterChange("target-1")
    renderList().handleStateFilterChange("ACTIVE")
    newFilter.resolve({ items: [scan("current")], nextCursor: "current-cursor" })
    await newFilter.promise
    oldFilter.resolve({ items: [scan("stale")], nextCursor: "stale-cursor" })
    await oldFilter.promise
    await Promise.resolve()

    const list = renderList()
    expect(list.scans.map((item) => item.id)).toEqual(["current"])
    expect(list.nextCursor).toBe("current-cursor")
    expect(apiGetPaginated.mock.calls.map((call) => call[1])).toEqual([
      { workspaceId: "workspace-1", targetId: "target-1" },
      { workspaceId: "workspace-1", targetId: "target-1", state: "ACTIVE" },
    ])
  })

  it("does not append an old page after a filter change", async () => {
    const oldPage = deferredPage()
    const newFilter = deferredPage()
    apiGetPaginated.mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(newFilter.promise)

    const load = renderList().handleLoadMore()
    renderList().handleTargetFilterChange("target-1")
    newFilter.resolve({ items: [scan("current")], nextCursor: null })
    await newFilter.promise
    oldPage.resolve({ items: [scan("stale")], nextCursor: "stale-cursor" })
    await load

    const list = renderList()
    expect(list.scans.map((item) => item.id)).toEqual(["current"])
    expect(list.nextCursor).toBeNull()
  })

  it("ignores an old filter failure after the current filter succeeds", async () => {
    const oldFilter = deferredPage()
    const newFilter = deferredPage()
    apiGetPaginated.mockReturnValueOnce(oldFilter.promise).mockReturnValueOnce(newFilter.promise)

    renderList().handleTargetFilterChange("target-1")
    renderList().handleStateFilterChange("ACTIVE")
    newFilter.resolve({ items: [scan("current")], nextCursor: null })
    await newFilter.promise
    oldFilter.reject(new Error("old request failed"))
    await oldFilter.promise.catch(() => {})
    await Promise.resolve()

    expect(renderList().pollStale).toBe(false)
  })
})
