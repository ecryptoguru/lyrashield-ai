import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { verifyTurnstile } from "./turnstile"

const mocks = vi.hoisted(() => ({
  info: vi.fn<(message: string, data: Record<string, unknown>) => void>(),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: mocks.info } }))

const proof = "private-proof-fixture"
const secret = "private-key-fixture"
const now = new Date("2026-10-13T14:50:00Z")

function response(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers })
}

function events() {
  return mocks.info.mock.calls.map(([, data]) => data)
}

beforeEach(() => {
  mocks.info.mockReset()
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.stubEnv("TURNSTILE_SECRET_KEY", secret)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("Turnstile outcome diagnostics", () => {
  it("retains bounded outcome metadata without forwarding private provider fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          {
            success: false,
            hostname: "private-host-fixture",
            action: "private-action-fixture",
            challenge_ts: "2026-10-13T14:49:00Z",
            "error-codes": ["timeout-or-duplicate", secret, proof, 123],
            cdata: "private-session-fixture",
            metadata: { ephemeral_id: "private-device-fixture" },
          },
          403,
          { "cf-ray": proof, "cf-cache-status": secret }
        )
      )
    )

    await expect(verifyTurnstile(proof)).resolves.toBe(false)
    expect(events()).toEqual([
      {
        invocationId: expect.stringMatching(/^[a-f\d-]{36}$/i),
        attempt: 1,
        outcome: "failed",
        httpStatus: 403,
        providerMode: "unclassified",
        errorCodes: ["timeout-or-duplicate", "unrecognized"],
        hostnamePresent: true,
        actionPresent: true,
        challengeAge: "fresh",
        upstreamRayFingerprint: null,
        upstreamCacheState: "unrecognized",
      },
    ])
    const serialized = JSON.stringify(mocks.info.mock.calls)
    for (const privateValue of [
      proof,
      secret,
      "private-session-fixture",
      "private-device-fixture",
      "private-host-fixture",
      "private-action-fixture",
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it("fingerprints an allowlisted provider correlation header without exposing its value", async () => {
    const ray = "abcdefabcdefabcd-IAD"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({ success: true }, 200, { "cf-ray": ray, "cf-cache-status": "DYNAMIC" })
      )
    )
    await expect(verifyTurnstile(proof)).resolves.toBe(true)
    expect(events()[0]).toMatchObject({
      outcome: "success",
      upstreamRayFingerprint: createHash("sha256").update(ray).digest("hex"),
      upstreamCacheState: "DYNAMIC",
      challengeAge: "missing-or-invalid",
    })
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(ray)
  })

  it("classifies a documented test credential without forwarding its value", async () => {
    const fixture = `1x${"0".repeat(31)}AA`
    vi.stubEnv("TURNSTILE_SECRET_KEY", fixture)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ success: true }))
    )
    await expect(verifyTurnstile(proof)).resolves.toBe(true)
    expect(events()[0]).toMatchObject({ providerMode: "documented-test" })
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(fixture)
  })

  it("correlates bounded retry attempts without retaining exception text", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error(`${secret} ${proof} private-session-fixture`)
    })
    vi.stubGlobal("fetch", fetchMock)
    const attempt = verifyTurnstile(proof)
    await vi.runAllTimersAsync()
    await expect(attempt).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(events().map((event) => event.attempt)).toEqual([1, 2, 3])
    expect(new Set(events().map((event) => event.invocationId)).size).toBe(1)
    expect(
      events().every((event) => event.outcome === "transient-error" && event.httpStatus === null)
    ).toBe(true)
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("private-")
  })

  it("records completed responses when JSON parsing fails without logging their bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`${secret} ${proof}`, { status: 502 }))
    )
    const attempt = verifyTurnstile(proof)
    await vi.runAllTimersAsync()
    await expect(attempt).resolves.toBe(false)
    expect(events()).toHaveLength(3)
    expect(
      events().every((event) => event.outcome === "transient-error" && event.httpStatus === 502)
    ).toBe(true)
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("private-")
  })

  it("keeps independent validations distinct even when their proof input is identical", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ success: true }))
    )
    await expect(verifyTurnstile(proof)).resolves.toBe(true)
    await expect(verifyTurnstile(proof)).resolves.toBe(true)
    expect(events()).toHaveLength(2)
    expect(new Set(events().map((event) => event.invocationId)).size).toBe(2)
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(proof)
  })

  it("keeps expired, future and malformed timestamps as flags rather than raw values", async () => {
    for (const [timestamp, expected] of [
      ["2026-10-13T14:40:00Z", "expired"],
      ["2026-10-13T15:00:00Z", "future"],
      [secret, "missing-or-invalid"],
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response({ success: false, challenge_ts: timestamp }))
      )
      await expect(verifyTurnstile(proof)).resolves.toBe(false)
      expect(events().at(-1)).toMatchObject({ challengeAge: expected })
      expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(timestamp)
    }
  })

  it("does not alter successful validation or retries when diagnostic logging fails", async () => {
    mocks.info.mockImplementation(() => {
      throw new Error("logging unavailable")
    })
    const fetchMock = vi.fn(async () => response({ success: true }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(verifyTurnstile(proof)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("preserves missing-input rejection without contacting the provider", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(verifyTurnstile(undefined)).resolves.toBe(false)
    vi.stubEnv("TURNSTILE_SECRET_KEY", "")
    await expect(verifyTurnstile(proof)).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.info).not.toHaveBeenCalled()
  })
})
