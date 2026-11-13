import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runEngineProcess: vi.fn(),
  readTextFileBounded: vi.fn(),
  env: { LYRASHIELD_AI_RESULT_CACHE_MODE: "off", LYRASHIELD_ENGINE_PATH: "lyrashield" },
}))
vi.mock("@lyrashield/config", () => ({ env: mocks.env }))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))
vi.mock("fs/promises", () => ({ writeFile: vi.fn(), rm: vi.fn() }))
vi.mock("./runner-process", () => ({ runEngineProcess: mocks.runEngineProcess }))
vi.mock("./runner-output", () => ({ readTextFileBounded: mocks.readTextFileBounded }))
vi.mock("./workspace-path", () => ({ ENGINE_WORK_ROOT: "/tmp/lyrashield-triage-contract-test" }))
vi.mock("@lyrashield/integrations", () => ({ getAiResultCacheRedis: () => null }))
import { runEngineTriage } from "./triage-runner"
import type { EngineProfile } from "./runner-config"

describe("pinned engine triage invocation", () => {
  it("never enables the legacy local cache that replays historical provider usage", async () => {
    const profile: EngineProfile = {
      model: "azure_ai/gpt-6-luna",
      reasoningEffort: "medium",
      delegateModel: "azure_ai/gpt-6-luna",
      delegateReasoningEffort: "medium",
    }
    const freshUsage = { request_count: 1, input_tokens: 20, output_tokens: 2 }
    mocks.runEngineProcess.mockImplementation(async (command: { args: string[] }) => {
      // The pinned engine returns prior usage verbatim when local caching is enabled.
      const llmUsage = command.args.includes("--cache-dir")
        ? { request_count: 99, input_tokens: 9900, output_tokens: 990 }
        : freshUsage
      mocks.readTextFileBounded.mockResolvedValue(JSON.stringify({ llmUsage }))
      return { exitCode: 0, timedOut: false, cancelled: false }
    })
    const result = await runEngineTriage({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      input: {},
      profile,
      maxBudgetUsd: 0.2,
      timeoutMs: 1000,
    })
    expect(result.llmUsage).toEqual(freshUsage)
    expect(result.source).toBe("provider")
  })
})
