import { describe, expect, it, vi } from "vitest"
import {
  MAX_PROVIDER_RETURN_REFRESHES,
  parseProviderReturnOutcome,
  resolveBillingReturnState,
  startBoundedProviderReturnRefresh,
} from "./billing-return-state"

describe("billing provider return state", () => {
  it.each(["success", "processing", "cancelled"] as const)(
    "accepts the bounded %s outcome",
    (value) => expect(parseProviderReturnOutcome(value)).toBe(value)
  )

  it.each([undefined, "paid", "//evil.example", "SUCCESS"])(
    "ignores an unknown provider outcome %s",
    (value) => expect(parseProviderReturnOutcome(value)).toBeNull()
  )

  it("treats a forged success query as pending until account state confirms access", () => {
    expect(resolveBillingReturnState({ checkout: "success", accountHasPaidPlan: false })).toEqual({
      kind: "checkout-pending",
      shouldRefresh: true,
    })
  })

  it("shows existing account state without claiming a specific payment settled", () => {
    expect(resolveBillingReturnState({ checkout: "processing", accountHasPaidPlan: true })).toEqual(
      { kind: "account-current", shouldRefresh: false }
    )
  })

  it("keeps top-up returns pending because the URL cannot confirm a balance change", () => {
    expect(resolveBillingReturnState({ topup: "success", accountHasPaidPlan: true })).toEqual({
      kind: "topup-pending",
      shouldRefresh: true,
    })
  })

  it("does not refresh after a canceled return or an unknown query value", () => {
    expect(resolveBillingReturnState({ checkout: "cancelled", accountHasPaidPlan: false })).toEqual(
      { kind: "cancelled", shouldRefresh: false }
    )
    expect(resolveBillingReturnState({ checkout: "forged", accountHasPaidPlan: false })).toEqual({
      kind: "none",
      shouldRefresh: false,
    })
  })
})

describe("startBoundedProviderReturnRefresh", () => {
  function fakeTimers() {
    let nextId = 1
    const callbacks = new Map<number, () => void>()
    return {
      callbacks,
      schedule: vi.fn((callback: () => void, delayMs: number) => {
        expect(delayMs).toBe(2_000)
        const id = nextId++
        callbacks.set(id, callback)
        return id as unknown as ReturnType<typeof setTimeout>
      }),
      cancel: vi.fn((timer: ReturnType<typeof setTimeout>) =>
        callbacks.delete(timer as unknown as number)
      ),
      runNext() {
        const entry = callbacks.entries().next().value as [number, () => void] | undefined
        if (!entry) throw new Error("No scheduled callback")
        callbacks.delete(entry[0])
        entry[1]()
      },
    }
  }

  it("stops after three read-only refreshes and reports still processing", () => {
    const timers = fakeTimers()
    const refresh = vi.fn()
    const onExhausted = vi.fn()
    startBoundedProviderReturnRefresh({
      refresh,
      isResolved: () => false,
      onExhausted,
      schedule: timers.schedule,
      cancel: timers.cancel,
    })

    for (let attempt = 0; attempt < MAX_PROVIDER_RETURN_REFRESHES; attempt++) timers.runNext()
    expect(refresh).toHaveBeenCalledTimes(MAX_PROVIDER_RETURN_REFRESHES)
    expect(onExhausted).not.toHaveBeenCalled()
    timers.runNext()
    expect(onExhausted).toHaveBeenCalledOnce()
  })

  it("stops when the refreshed server state confirms an active paid plan", () => {
    const timers = fakeTimers()
    const refresh = vi.fn()
    const onExhausted = vi.fn()
    let resolved = false
    startBoundedProviderReturnRefresh({
      refresh: () => {
        refresh()
        resolved = true
      },
      isResolved: () => resolved,
      onExhausted,
      schedule: timers.schedule,
      cancel: timers.cancel,
    })

    timers.runNext()
    expect(refresh).toHaveBeenCalledOnce()
    expect(timers.callbacks.size).toBe(0)
    expect(onExhausted).not.toHaveBeenCalled()
  })

  it("cancels its pending refresh when the notice unmounts", () => {
    const timers = fakeTimers()
    const refresh = vi.fn()
    const onExhausted = vi.fn()
    const stop = startBoundedProviderReturnRefresh({
      refresh,
      isResolved: () => false,
      onExhausted,
      schedule: timers.schedule,
      cancel: timers.cancel,
    })

    stop()
    expect(timers.callbacks.size).toBe(0)
    expect(timers.cancel).toHaveBeenCalledOnce()
  })
})
