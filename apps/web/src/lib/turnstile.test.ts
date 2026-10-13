import { createHash, randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { verifyTurnstile } from "./turnstile"

const mocks = vi.hoisted(() => ({
  info: vi.fn<(message: string, data: Record<string, unknown>) => void>(),
  set: vi.fn(),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: mocks.info } }))
vi.mock("@upstash/redis", () => ({
  Redis: class {
    set = mocks.set
  },
}))
const consumed = new Map<string, number>()

const proof = "private-proof-fixture"
// Generate a synthetic credential so no credential literal is embedded in source.
const secret = randomUUID()
const now = new Date("2026-10-13T14:50:00Z")

function response(body: unknown, status = 200, headers?: HeadersInit) {
  const payload =
    body && typeof body === "object" ? { challenge_ts: now.toISOString(), ...body } : body
  return new Response(JSON.stringify(payload), { status, headers })
}

function events() {
  return mocks.info.mock.calls.map(([, data]) => data)
}

beforeEach(() => {
  mocks.info.mockReset()
  mocks.set.mockReset()
  consumed.clear()
  mocks.set.mockImplementation(async (key: string, _value: string, options: { ex: number }) => {
    if ((consumed.get(key) ?? 0) > Date.now()) return null
    consumed.set(key, Date.now() + options.ex * 1000)
    return "OK"
  })
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.stubEnv("TURNSTILE_SECRET_KEY", secret)
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example.test")
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", randomUUID())
})

describe("application-owned proof consumption", () => {
  function providerSuccess() {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      response({ success: true })
    )
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }

  it("allows one concurrent winner across independent verifier modules", async () => {
    const fetchMock = providerSuccess()
    vi.resetModules()
    const replica = await import("./turnstile")
    const results = await Promise.all([verifyTurnstile(proof), replica.verifyTurnstile(proof)])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("uses the same canonical proof for digest and provider, blocking whitespace aliases", async () => {
    const fetchMock = providerSuccess()
    await expect(verifyTurnstile(` \t${proof}\n`)).resolves.toBe(true)
    await expect(verifyTurnstile(proof)).resolves.toBe(false)
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams
    expect(body.get("response")).toBe(proof)
    expect(mocks.set).toHaveBeenCalledWith(
      `turnstile-proof:v1:${createHash("sha256").update(proof).digest("hex")}`,
      "1",
      { nx: true, ex: 360 }
    )
    expect(JSON.stringify(mocks.set.mock.calls)).not.toContain(proof)
  })

  it("rejects blank and oversized proofs before storage or provider work", async () => {
    const fetchMock = providerSuccess()
    for (const input of [" \t", "x".repeat(2049)]) {
      await expect(verifyTurnstile(input)).resolves.toBe(false)
    }
    expect(mocks.set).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([null, undefined, true, "unexpected"])(
    "fails closed for ambiguous store result %s",
    async (value) => {
      const fetchMock = providerSuccess()
      mocks.set.mockResolvedValue(value)
      await expect(verifyTurnstile(proof)).resolves.toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it("fails closed without configured storage or after a write response is lost", async () => {
    const fetchMock = providerSuccess()
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "")
    await expect(verifyTurnstile(proof)).resolves.toBe(false)
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example.test")
    const atomicSet = mocks.set.getMockImplementation()!
    mocks.set.mockImplementationOnce(async (...args) => {
      await atomicSet(...args)
      throw new Error(`${proof} ${secret}`)
    })
    await expect(verifyTurnstile(proof)).resolves.toBe(false)
    await expect(verifyTurnstile(proof)).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(proof)
  })

  it("does not release a rejected proof and permits a new proof", async () => {
    const fetchMock = vi.fn(async () => response({ success: false }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(verifyTurnstile(proof)).resolves.toBe(false)
    fetchMock.mockImplementation(async () => response({ success: true }))
    await expect(verifyTurnstile(proof)).resolves.toBe(false)
    await expect(verifyTurnstile(`${proof}-fresh`)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("keeps a consumed proof after exhausted transient failures", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("lost response")
    })
    vi.stubGlobal("fetch", fetchMock)
    const pending = verifyTurnstile(proof)
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBe(false)
    await expect(verifyTurnstile(proof)).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(mocks.set).toHaveBeenCalledTimes(2)
  })

  it("reuses one provider idempotency UUID inside owned retries", async () => {
    const bodies: URLSearchParams[] = []
    let attempts = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        bodies.push(init.body)
        if (++attempts === 1) throw new Error("lost upstream response")
        return response({ success: true })
      })
    )
    const pending = verifyTurnstile(proof)
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBe(true)
    const ids = bodies.map((body) => body.get("idempotency_key"))
    expect(ids[0]).toMatch(/^[a-f\d-]{36}$/i)
    expect(ids[1]).toBe(ids[0])
    expect(mocks.set).toHaveBeenCalledTimes(1)
  })

  it("rejects expired proof after its consumption marker expires", async () => {
    providerSuccess()
    await expect(verifyTurnstile(proof)).resolves.toBe(true)
    vi.advanceTimersByTime(360_001)
    await expect(verifyTurnstile(proof)).resolves.toBe(false)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ success: true, challenge_ts: new Date().toISOString() }))
    )
    await expect(verifyTurnstile(`${proof}-fresh`)).resolves.toBe(true)
  })

  it.each([
    undefined,
    "bad",
    "2026-02-30T14:50:00Z",
    "2026-10-13T14:45:00Z",
    "2026-10-13T14:50:31Z",
  ])(
    "rejects successful responses with invalid or out-of-window timestamp %s",
    async (timestamp) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response({ success: true, challenge_ts: timestamp }))
      )
      await expect(verifyTurnstile(proof)).resolves.toBe(false)
      expect(events().at(-1)).toMatchObject({ outcome: "failed" })
    }
  )

  it("allows bounded clock skew and rejects HTTP failures even with affirmative JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ success: true, challenge_ts: "2026-10-13T14:50:30Z" }))
    )
    await expect(verifyTurnstile(proof)).resolves.toBe(true)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ success: true }, 503))
    )
    await expect(verifyTurnstile(`${proof}-fresh`)).resolves.toBe(false)
  })

  it.each(["2026-10-13T14:49:59.123456789Z", "2026-10-13T20:20:00+05:30"])(
    "accepts fresh ISO timestamps with precision or explicit offset: %s",
    async (timestamp) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response({ success: true, challenge_ts: timestamp }))
      )
      await expect(verifyTurnstile(proof)).resolves.toBe(true)
    }
  )
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
      challengeAge: "fresh",
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

  it("rejects independent reuse even when the provider would accept it again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ success: true }))
    )
    await expect(verifyTurnstile(proof)).resolves.toBe(true)
    await expect(verifyTurnstile(proof)).resolves.toBe(false)
    expect(events()).toHaveLength(1)
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
      await expect(verifyTurnstile(`${proof}-${expected}`)).resolves.toBe(false)
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
