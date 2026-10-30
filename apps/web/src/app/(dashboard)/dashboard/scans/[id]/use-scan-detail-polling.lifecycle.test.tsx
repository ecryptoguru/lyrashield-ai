import type { DependencyList } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Exercise the production hook and poll loop with effect cleanup/dependencies,
// state commits and real fake-clock timers. No DOM test dependency is installed.
const runtime = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as Array<{
    value?: unknown
    dependencies?: DependencyList
    cleanup?: () => void
  }>,
  effects: [] as Array<() => void>,
  changed(previous: DependencyList | undefined, next: DependencyList) {
    return !previous || next.some((value, index) => !Object.is(value, previous[index]))
  },
}))
const api = vi.hoisted(() => ({
  apiGetConditional: vi.fn(),
  apiGetPaginated: vi.fn(),
  apiGet: vi.fn(),
  router: { refresh: vi.fn() },
}))
vi.mock("next/navigation", () => ({ useRouter: () => api.router }))
vi.mock("@/lib/api-client", () => api)
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const slot = (runtime.slots[runtime.cursor++] ??= { value: initial })
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next
      },
    ]
  },
  useRef(initial: unknown) {
    return (runtime.slots[runtime.cursor++] ??= { value: { current: initial } }).value
  },
  useCallback(callback: unknown, dependencies: DependencyList) {
    const slot = (runtime.slots[runtime.cursor++] ??= {})
    if (runtime.changed(slot.dependencies, dependencies)) {
      slot.value = callback
      slot.dependencies = dependencies
    }
    return slot.value
  },
  useEffect(effect: () => void | (() => void), dependencies: DependencyList) {
    const slot = (runtime.slots[runtime.cursor++] ??= {})
    if (runtime.changed(slot.dependencies, dependencies)) {
      slot.dependencies = dependencies
      runtime.effects.push(() => {
        slot.cleanup?.()
        slot.cleanup = effect() || undefined
      })
    }
  },
}))

import { useScanDetailPolling } from "./use-scan-detail-polling"
import { ScanCapacityBanner } from "./scan-capacity-banner"
import type { ScanData, ScanPollData } from "./scan-detail-types"

const held = {
  state: "RUNNING",
  admissionHeld: true,
  executionStopped: false,
  multiplier: 1,
  fundedMinutes: 5,
  runtimeLimitMs: 300000,
  observedMs: 61000,
  chargedMinutes: 0,
  absorbedMinutes: 0,
}
const released = {
  ...held,
  state: "SETTLED",
  admissionHeld: false,
  executionStopped: true,
  chargedMinutes: 2,
}
function scan(status: string): ScanData {
  return {
    id: "scan-1",
    workspaceId: "workspace-1",
    status,
    goal: "TEST_APP",
    mode: "STANDARD",
    triggerType: "manual",
    startedAt: null,
    endedAt: null,
    summary: null,
    errorCategory: null,
    errorMessage: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    target: null,
    events: [],
    executionPlan: null,
    integrity: { manifestChecksum: null, coverage: [] },
    aiSecurity: null,
    capacity: held,
  }
}
function response(initial: ScanData, status: string, capacity = held) {
  const data: ScanPollData = { ...initial, status, capacity }
  return { data, status: 200, etag: `"${status}-${capacity.state}"` }
}
function PollingHarness(initial: ScanData) {
  return useScanDetailPolling(initial, [])
}
function render(initial: ScanData) {
  runtime.cursor = 0
  const result = PollingHarness(initial)
  for (const effect of runtime.effects.splice(0)) effect()
  return result
}
function banner(result: ReturnType<typeof render>) {
  return renderToStaticMarkup(<ScanCapacityBanner scan={result.scan} />)
}
async function tick(initial: ScanData, milliseconds = 5000) {
  await vi.advanceTimersByTimeAsync(milliseconds)
  return render(initial)
}

beforeEach(() => {
  vi.useFakeTimers()
  runtime.cursor = 0
  runtime.slots = []
  runtime.effects = []
  vi.clearAllMocks()
  api.apiGetConditional.mockReset()
  api.apiGetPaginated.mockResolvedValue({ items: [] })
  api.apiGet.mockResolvedValue(null)
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }))
  vi.stubGlobal("window", { setTimeout, clearTimeout })
})
afterEach(() => {
  for (const slot of runtime.slots) slot.cleanup?.()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("terminal capacity polling lifecycle", () => {
  it.each(["CANCELLED", "COMPLETED"])(
    "polls a terminal-held %s SSR snapshot until settlement and then stops",
    async (status) => {
      const initial = { ...scan(status), capacity: { ...held, executionStopped: true } }
      api.apiGetConditional.mockResolvedValue(response(initial, status, released))
      const first = render(initial)
      expect(first.isActive).toBe(false)
      expect(banner(first)).toContain("Finalizing this review")
      const settled = await tick(initial)
      expect(api.apiGetConditional).toHaveBeenCalledTimes(1)
      expect(settled.isActive).toBe(false)
      expect(banner(settled)).toContain("2 agent-minutes charged")
      expect(banner(settled)).not.toContain("Finalizing this review")
      await tick(initial, 120000)
      expect(api.apiGetConditional).toHaveBeenCalledTimes(1)
    }
  )

  it("keeps polling after authoritative cancellation without leaving Cancel active", async () => {
    const initial = scan("RUNNING")
    api.apiGetConditional
      .mockResolvedValueOnce(response(initial, "CANCELLED"))
      .mockResolvedValue(response(initial, "CANCELLED", released))
    const first = render(initial)
    expect(first.isActive).toBe(true)
    first.applyCancelledScan("CANCELLED", "2026-10-30T00:01:01.000Z")
    const cancelled = render(initial)
    expect(cancelled.isActive).toBe(false)
    expect(banner(cancelled)).toContain("Cancellation requested")
    const heldResult = await tick(initial)
    expect(api.apiGetConditional).toHaveBeenCalledTimes(1)
    expect(banner(heldResult)).toContain("Cancellation requested")
    const settled = await tick(initial)
    expect(api.apiGetConditional).toHaveBeenCalledTimes(2)
    expect(banner(settled)).toContain("2 agent-minutes charged")
    expect(banner(settled)).not.toContain("Cancellation requested")
    await tick(initial, 120000)
    expect(api.apiGetConditional).toHaveBeenCalledTimes(2)
  })

  it("continues after a completed response until the capacity receipt releases admission", async () => {
    const initial = scan("RUNNING")
    api.apiGetConditional
      .mockResolvedValueOnce(response(initial, "COMPLETED", { ...held, executionStopped: true }))
      .mockResolvedValue(response(initial, "COMPLETED", released))
    render(initial)
    const completed = await tick(initial)
    expect(completed.isActive).toBe(false)
    expect(banner(completed)).toContain("Finalizing this review")
    const settled = await tick(initial)
    expect(api.apiGetConditional).toHaveBeenCalledTimes(2)
    expect(banner(settled)).toContain("2 agent-minutes charged")
    await tick(initial, 120000)
    expect(api.apiGetConditional).toHaveBeenCalledTimes(2)
  })

  it("suspends held-capacity polling while hidden and resumes immediately when visible", async () => {
    const initial = scan("CANCELLED")
    api.apiGetConditional.mockResolvedValue(response(initial, "CANCELLED", released))
    render(initial)
    Object.assign(document, { hidden: true })
    document.dispatchEvent(new Event("visibilitychange"))
    await tick(initial, 120000)
    expect(api.apiGetConditional).not.toHaveBeenCalled()
    Object.assign(document, { hidden: false })
    document.dispatchEvent(new Event("visibilitychange"))
    const settled = await tick(initial, 0)
    expect(api.apiGetConditional).toHaveBeenCalledTimes(1)
    expect(banner(settled)).toContain("2 agent-minutes charged")
    await tick(initial, 120000)
    expect(api.apiGetConditional).toHaveBeenCalledTimes(1)
  })

  it("aborts an in-flight pre-cancel response without losing the capacity follow-up", async () => {
    const initial = scan("RUNNING")
    let finishRequest!: (value: ReturnType<typeof response>) => void
    let requestSignal!: AbortSignal
    api.apiGetConditional
      .mockImplementationOnce((_url, { signal }) => {
        requestSignal = signal
        return new Promise((resolve) => {
          finishRequest = resolve
        })
      })
      .mockResolvedValue(response(initial, "CANCELLED", released))
    const active = render(initial)
    vi.advanceTimersByTime(5000)
    expect(requestSignal.aborted).toBe(false)
    active.applyCancelledScan("CANCELLED", "2026-10-30T00:01:01.000Z")
    expect(requestSignal.aborted).toBe(true)
    finishRequest(response(initial, "RUNNING"))
    const cancelled = await tick(initial, 0)
    expect(cancelled.scan.status).toBe("CANCELLED")
    expect(cancelled.isActive).toBe(false)
    const settled = await tick(initial)
    expect(api.apiGetConditional).toHaveBeenCalledTimes(2)
    expect(banner(settled)).toContain("2 agent-minutes charged")
    await tick(initial, 120000)
    expect(api.apiGetConditional).toHaveBeenCalledTimes(2)
  })

  it.each([null, released])(
    "does not poll terminal legacy or already-released snapshots (%s)",
    async (capacity) => {
      const initial = { ...scan("COMPLETED"), capacity }
      render(initial)
      await tick(initial, 120000)
      expect(api.apiGetConditional).not.toHaveBeenCalled()
    }
  )
})
