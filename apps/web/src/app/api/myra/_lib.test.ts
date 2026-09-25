import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_DASHBOARD_ENABLED: "1",
  MYRA_PUBLIC_ENABLED: "0",
  MYRA_OPERATOR_ENABLED: "0",
  MYRA_WRITES_ENABLED: "1",
  MYRA_PUBLIC_BOOKING_ENABLED: "0",
}))

vi.mock("@lyrashield/config", () => ({
  env,
  myraDashboardAllowed: (input: { emailVerified: boolean }) => input.emailVerified,
}))

const { myraPrincipalEnabled, myraWritesEnabled, myraSseResponse } = await import("./_lib")

describe("Myra SSE cancellation", () => {
  it("passes request abort to the producer and stops it", async () => {
    const abort = new AbortController()
    let producerSignal: AbortSignal | undefined
    const response = myraSseResponse(
      new Request("https://example.test", { signal: abort.signal }),
      async function* (signal) {
        producerSignal = signal
        yield { type: "ready", conversationId: "conversation", traceId: "trace" } as const
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        )
      }
    )
    const reader = response.body!.getReader()
    await reader.read()
    abort.abort()
    await vi.waitFor(() => expect(producerSignal?.aborted).toBe(true))
    await reader.cancel()
  })

  it("passes reader cancellation to the producer", async () => {
    let producerSignal: AbortSignal | undefined
    const response = myraSseResponse(new Request("https://example.test"), async function* (signal) {
      producerSignal = signal
      yield { type: "ready", conversationId: "conversation", traceId: "trace" } as const
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      )
    })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    expect(producerSignal?.aborted).toBe(true)
  })

  it("does not start a producer when the request was already aborted", async () => {
    const abort = new AbortController()
    abort.abort()
    const producer = vi.fn(async function* () {
      yield { type: "ready", conversationId: "conversation", traceId: "trace" } as const
    })
    const response = myraSseResponse(
      new Request("https://example.test", { signal: abort.signal }),
      producer
    )
    expect(producer).not.toHaveBeenCalled()
    expect((await response.body!.getReader().read()).done).toBe(true)
  })
})

describe("Myra verified-account gate", () => {
  beforeEach(() => {
    env.MYRA_DASHBOARD_ENABLED = "1"
    env.MYRA_WRITES_ENABLED = "1"
    env.MYRA_PUBLIC_BOOKING_ENABLED = "0"
  })

  it("admits every verified user", () => {
    const ankit = {
      kind: "user" as const,
      accountId: "account-1",
      sessionId: "session-1",
      email: "ankit@lyrashieldai.com",
      emailVerified: true,
      workspaceId: null,
      role: null,
    }
    expect(myraPrincipalEnabled(ankit)).toBe(true)
    expect(myraWritesEnabled(ankit)).toBe(true)
    expect(myraPrincipalEnabled({ ...ankit, email: "other@example.com" })).toBe(true)
    expect(myraWritesEnabled({ ...ankit, emailVerified: false })).toBe(false)
    expect(myraWritesEnabled()).toBe(false)
  })

  it("denies every write while MYRA_WRITES_ENABLED is off", () => {
    env.MYRA_WRITES_ENABLED = "0"
    const ankit = {
      kind: "user" as const,
      accountId: "account-1",
      sessionId: "session-1",
      email: "ankit@lyrashieldai.com",
      emailVerified: true,
      workspaceId: null,
      role: null,
    }
    const anonymous = { kind: "anonymous" as const, publicSessionId: "ps-1" }
    expect(myraWritesEnabled(ankit)).toBe(false)
    expect(myraWritesEnabled(anonymous)).toBe(false)
  })

  it("permits verified-email support cases but not anonymous booking", () => {
    const anonymous = { kind: "anonymous" as const, publicSessionId: "ps-1" }
    expect(myraWritesEnabled(anonymous)).toBe(true)
    expect(myraWritesEnabled(anonymous, "book_demo")).toBe(false)
    expect(myraWritesEnabled(anonymous, "submit_support_case")).toBe(true)
  })

  it("admits an anonymous principal only for public-booking operations when the flag is on", () => {
    env.MYRA_PUBLIC_BOOKING_ENABLED = "1"
    const anonymous = { kind: "anonymous" as const, publicSessionId: "ps-1" }
    // Coarse route check (operation unknown until the proposal loads) and the
    // operation-specific checks agree on the booking pair.
    expect(myraWritesEnabled(anonymous)).toBe(true)
    expect(myraWritesEnabled(anonymous, "book_demo")).toBe(true)
    expect(myraWritesEnabled(anonymous, "manage_own_demo")).toBe(true)
    // Case replies remain denied; support cases require verified reply email
    // in the executor, independent of booking admission.
    expect(myraWritesEnabled(anonymous, "send_case_reply")).toBe(false)
    expect(myraWritesEnabled(anonymous, "submit_support_case")).toBe(true)
  })

  it("admits user writes for a verified non-production account", () => {
    const dev = {
      kind: "user" as const,
      accountId: "account-2",
      sessionId: "session-2",
      email: "dev@example.com",
      emailVerified: true,
      workspaceId: null,
      role: null,
    }
    expect(myraWritesEnabled(dev)).toBe(true)
    expect(myraPrincipalEnabled(dev)).toBe(true)
  })
})
