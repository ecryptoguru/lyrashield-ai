import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const loggerMocks = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

const envState = vi.hoisted(() => ({ NODE_ENV: "test" }) as Record<string, string | undefined>)

vi.mock("@lyrashield/config", () => ({
  env: envState,
}))
vi.mock("@lyrashield/logger", () => ({ logger: loggerMocks }))
vi.mock("@lyrashield/db", () => ({ getSystemPrisma: vi.fn() }))

import { INTERNAL_API_KEY_HEADER, requireInternalApiKey } from "./license-service"

function requestWithKey(key?: string) {
  const headers = new Headers()
  if (key !== undefined) headers.set(INTERNAL_API_KEY_HEADER, key)
  return new Request("http://localhost/api/licenses/issue", { method: "POST", headers })
}

async function bodyOf(response: Response): Promise<string> {
  return response.text()
}

const EXPECTED_KEY = "internal-secret-key-value"

describe("requireInternalApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    envState.NODE_ENV = "test"
    delete envState.LYRASHIELD_INTERNAL_API_KEY
  })

  afterEach(() => {
    delete envState.LYRASHIELD_INTERNAL_API_KEY
  })

  it("rejects in production when the expected key is missing (fail closed)", async () => {
    envState.NODE_ENV = "production"
    const result = requireInternalApiKey(requestWithKey(EXPECTED_KEY))
    expect(result).toBeInstanceOf(Response)
    expect(result.status).toBe(403)
    expect(await bodyOf(result)).toContain("invalid internal API key")
    expect(loggerMocks.error).toHaveBeenCalledWith(expect.any(String), {
      reason: "internal_key_missing",
    })
  })

  it("rejects in production when the expected key is empty (same missing-config reason)", () => {
    envState.NODE_ENV = "production"
    envState.LYRASHIELD_INTERNAL_API_KEY = ""
    const result = requireInternalApiKey(requestWithKey(EXPECTED_KEY))
    expect(result).toBeInstanceOf(Response)
    expect(result.status).toBe(403)
    // Empty config is an "internal_key_missing" reason, not a mismatch.
    expect(loggerMocks.error).toHaveBeenCalledWith(expect.any(String), {
      reason: "internal_key_missing",
    })
  })

  it("allows in dev and test when the expected key is missing (explicit, logged)", () => {
    for (const nodeEnv of ["development", "test"]) {
      vi.clearAllMocks()
      envState.NODE_ENV = nodeEnv
      expect(requireInternalApiKey(requestWithKey())).toBeNull()
      expect(loggerMocks.warn).toHaveBeenCalledTimes(1)
    }
  })

  it("allows the correct key in production", () => {
    envState.NODE_ENV = "production"
    envState.LYRASHIELD_INTERNAL_API_KEY = EXPECTED_KEY
    expect(requireInternalApiKey(requestWithKey(EXPECTED_KEY))).toBeNull()
    expect(loggerMocks.error).not.toHaveBeenCalled()
  })

  it("rejects wrong/absent keys generically without leaking key material", async () => {
    envState.NODE_ENV = "production"
    envState.LYRASHIELD_INTERNAL_API_KEY = EXPECTED_KEY

    for (const provided of [undefined, "", "wrong-key"]) {
      const result = requireInternalApiKey(requestWithKey(provided))
      expect(result).toBeInstanceOf(Response)
      expect(result.status).toBe(403)
      expect(await bodyOf(result)).toContain("invalid internal API key")
    }

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "internal_key_mismatch" })
    )
    // No key material in any log call.
    for (const call of [...loggerMocks.warn.mock.calls, ...loggerMocks.error.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(EXPECTED_KEY)
      expect(JSON.stringify(call)).not.toContain("wrong-key")
    }
  })

  it("compares timing-safely even when raw lengths differ (no throw)", () => {
    envState.NODE_ENV = "production"
    envState.LYRASHIELD_INTERNAL_API_KEY = EXPECTED_KEY
    // Hashing makes both sides fixed-length so timingSafeEqual never throws
    // on differing raw lengths.
    expect(requireInternalApiKey(requestWithKey("x")).status).toBe(403)
    expect(requireInternalApiKey(requestWithKey("x".repeat(500))).status).toBe(403)
  })
})
