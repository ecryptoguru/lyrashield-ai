import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const controlKeys = [
  "LYRASHIELD_RUN_RECORD_V1_1",
  "LYRASHIELD_PENDING_HTTP_EVIDENCE",
  "LLM_API_MODE",
  "DEDUPE_LLM_API_MODE",
] as const

beforeEach(() => {
  vi.resetModules()
  for (const key of controlKeys) vi.stubEnv(key, undefined)
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MYRA_")) vi.stubEnv(key, undefined)
  }
  vi.stubEnv("NODE_ENV", "test")
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@127.0.0.1:1/lyrashield_test")
  vi.stubEnv("BETTER_AUTH_SECRET", "fixture-secret".repeat(4))
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000")
  vi.stubEnv("LYRASHIELD_ENGINE_SANDBOX_NETWORK", "test-restricted-egress")
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function launchEnvironment() {
  const { buildEngineEnv } = await import("./runner-config")
  return buildEngineEnv({
    model: "azure/gpt-6-luna",
    reasoningEffort: "medium",
    delegateReasoningEffort: "medium",
  })
}

describe("static engine deployment controls", () => {
  it("keeps the default 1.0 writer and inherited endpoint policy", async () => {
    const environment = await launchEnvironment()
    expect(environment.LYRASHIELD_RUN_RECORD_V1_1).toBe("0")
    expect(environment.LYRASHIELD_PENDING_HTTP_EVIDENCE).toBe("0")
    expect(environment.LLM_API_MODE).toBeUndefined()
    expect(environment.DEDUPE_LLM_API_MODE).toBeUndefined()
  })

  it.each([
    ["0", "0"],
    ["1", "0"],
    ["1", "1"],
  ])("forwards writer controls %s/%s unchanged", async (runRecord, pendingHttp) => {
    vi.stubEnv("LYRASHIELD_RUN_RECORD_V1_1", runRecord)
    vi.stubEnv("LYRASHIELD_PENDING_HTTP_EVIDENCE", pendingHttp)
    const environment = await launchEnvironment()
    expect(environment.LYRASHIELD_RUN_RECORD_V1_1).toBe(runRecord)
    expect(environment.LYRASHIELD_PENDING_HTTP_EVIDENCE).toBe(pendingHttp)
  })

  it.each([undefined, "0"])("rejects pending evidence without 1.1 (%s)", async (value) => {
    vi.stubEnv("LYRASHIELD_RUN_RECORD_V1_1", value)
    vi.stubEnv("LYRASHIELD_PENDING_HTTP_EVIDENCE", "1")
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(launchEnvironment()).rejects.toThrow("Invalid environment configuration")
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining(
        "LYRASHIELD_PENDING_HTTP_EVIDENCE requires LYRASHIELD_RUN_RECORD_V1_1=1"
      )
    )
  })

  it.each(
    controlKeys.flatMap((key) =>
      ["", "true", "false", "yes", "1 "].map((value) => ({ key, value }))
    )
  )(
    "rejects malformed $key=$value before constructing a launch environment",
    async ({ key, value }) => {
      vi.stubEnv(key, value)
      const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})
      await expect(launchEnvironment()).rejects.toThrow("Invalid environment configuration")
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining(key))
    }
  )

  it.each(["auto", "responses", "chat_completions"])(
    "forwards bounded endpoint policy %s",
    async (mode) => {
      vi.stubEnv("LLM_API_MODE", mode)
      vi.stubEnv("DEDUPE_LLM_API_MODE", mode)
      const environment = await launchEnvironment()
      expect(environment.LLM_API_MODE).toBe(mode)
      expect(environment.DEDUPE_LLM_API_MODE).toBe(mode)
    }
  )

  it("preserves absent dedupe policy when main policy is explicit", async () => {
    vi.stubEnv("LLM_API_MODE", "responses")
    const environment = await launchEnvironment()
    expect(environment.LLM_API_MODE).toBe("responses")
    expect(environment.DEDUPE_LLM_API_MODE).toBeUndefined()
  })

  it("uses validated startup controls despite ambient or scan-scoped overrides", async () => {
    vi.stubEnv("LLM_API_MODE", "responses")
    const { buildEngineEnv } = await import("./runner-config")
    vi.stubEnv("LYRASHIELD_RUN_RECORD_V1_1", "1")
    vi.stubEnv("LYRASHIELD_PENDING_HTTP_EVIDENCE", "1")
    vi.stubEnv("LLM_API_MODE", "chat_completions")
    vi.stubEnv("DEDUPE_LLM_API_MODE", "chat_completions")
    vi.stubEnv("LLM_EXTRA_HEADERS", '{"unreviewed":"value"}')
    vi.stubEnv("DEDUPE_LLM_API_KEY", "unreviewed-dedupe-key")
    const injectedControls = {
      LYRASHIELD_RUN_RECORD_V1_1: "1",
      LYRASHIELD_PENDING_HTTP_EVIDENCE: "1",
      LLM_API_MODE: "chat_completions",
      DEDUPE_LLM_API_MODE: "chat_completions",
    }
    const profile = {
      model: "azure/gpt-6-luna",
      reasoningEffort: "medium" as const,
      delegateReasoningEffort: "medium" as const,
      ...injectedControls,
    }
    const environment = buildEngineEnv(profile, "scan-fixture", {
      runType: "web_application",
      ...injectedControls,
    })
    expect(environment.LYRASHIELD_RUN_RECORD_V1_1).toBe("0")
    expect(environment.LYRASHIELD_PENDING_HTTP_EVIDENCE).toBe("0")
    expect(environment.LLM_API_MODE).toBe("responses")
    expect(environment.DEDUPE_LLM_API_MODE).toBeUndefined()
    expect(environment.LLM_EXTRA_HEADERS).toBeUndefined()
    expect(environment.DEDUPE_LLM_API_KEY).toBeUndefined()
  })
})
