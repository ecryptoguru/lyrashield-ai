import type { ReactElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  current: null as boolean | null,
  set: vi.fn<(value: boolean | null) => void>(),
  effect: undefined as (() => void | (() => void)) | undefined,
}))
const analytics = vi.hoisted(() => ({
  resolve: vi.fn<() => Promise<boolean | null>>(),
  allows: vi.fn<() => boolean>(),
}))

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: boolean | null) => {
    state.current = initial
    return [state.current, state.set]
  },
  useEffect: (effect: () => void | (() => void)) => {
    state.effect = effect
  },
}))

vi.mock("@/lib/analytics", () => ({
  ANALYTICS_PREFERENCE_EVENT: "lyrashield:analytics-preference",
  analyticsPermissionAllowsOptionalCollection: analytics.allows,
  resolveAnalyticsPreference: analytics.resolve,
}))

import { BrowserErrorMonitorGate } from "./browser-error-monitor"

type MonitorProps = { optionalCollectionEnabled: boolean | null }

const listeners = new Map<string, (event: Event) => void>()

function dispatchPreference(value: unknown) {
  listeners.get("lyrashield:analytics-preference")?.({ detail: value } as Event)
}

function renderGate() {
  return BrowserErrorMonitorGate() as ReactElement<MonitorProps>
}

describe("BrowserErrorMonitorGate", () => {
  beforeEach(() => {
    state.current = null
    state.set.mockClear()
    state.effect = undefined
    analytics.resolve.mockReset()
    analytics.allows.mockReset().mockReturnValue(true)
    listeners.clear()

    vi.stubGlobal("window", {
      addEventListener: vi.fn((name: string, listener: (event: Event) => void) => {
        listeners.set(name, listener)
      }),
      removeEventListener: vi.fn((name: string) => {
        listeners.delete(name)
      }),
    })
  })

  it("keeps the monitor disabled until resolved permission allows collection", async () => {
    let resolve!: (value: boolean | null) => void
    analytics.resolve.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )

    expect(renderGate().props.optionalCollectionEnabled).toBeNull()
    const cleanup = state.effect?.()
    expect(analytics.resolve).toHaveBeenCalledOnce()

    resolve(true)
    await Promise.resolve()

    expect(analytics.allows).toHaveBeenCalledOnce()
    expect(state.set).toHaveBeenLastCalledWith(true)
    cleanup?.()
  })

  it("honors preference events over stale resolution and gates a late opt-in", async () => {
    let resolve!: (value: boolean | null) => void
    analytics.resolve.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )

    renderGate()
    const cleanup = state.effect?.()
    dispatchPreference(false)
    expect(state.set).toHaveBeenLastCalledWith(false)

    resolve(true)
    await Promise.resolve()
    expect(state.set).toHaveBeenLastCalledWith(false)

    analytics.allows.mockReturnValue(false)
    dispatchPreference(true)
    expect(state.set).toHaveBeenLastCalledWith(false)
    cleanup?.()
  })

  it("ignores a late resolution after unmount and removes its event listener", async () => {
    let resolve!: (value: boolean | null) => void
    analytics.resolve.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )

    renderGate()
    const cleanup = state.effect?.()
    cleanup?.()
    resolve(true)
    await Promise.resolve()

    expect(state.set).not.toHaveBeenCalled()
    expect(listeners.has("lyrashield:analytics-preference")).toBe(false)
  })
})
