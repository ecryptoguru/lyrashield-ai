import { execFileSync } from "child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, realpath, rm, utimes, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

vi.mock("@lyrashield/config", () => ({
  env: {
    LYRASHIELD_ENGINE_PATH: "",
    LYRASHIELD_IMAGE: "",
    REDIS_URL: "redis://localhost:6379",
    STRIX_SANDBOX_MEM_LIMIT: "4g",
    STRIX_SANDBOX_CPUS: "2",
    STRIX_SANDBOX_PIDS_LIMIT: "512",
  },
}))
vi.mock("@lyrashield/db", () => ({
  addScanEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import {
  collectEngineFailureType,
  createKillEscalation,
  cleanupEngineWorkspace,
  extractEngineFailureType,
  findRunOutputDir,
  interpretExitCode,
  prepareEngineWorkspace,
  assertRepositoryScanRuntimeConfigured,
  buildEngineEnv,
  resolveEngineSourceCheckout,
  resolveEngineSourceRevision,
  resolveEngineProfile,
  resolveEngineSandboxNetwork,
  resolveEngineTimeoutMs,
  terminateActiveEngineProcesses,
  trackActiveEngineProcess,
} from "./runner"

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function createRun(
  workDir: string,
  layout: "strix_runs" | "lyrashield_runs",
  name: string,
  artifact: "run.json" | "vulnerabilities.json",
  mtime: Date
): Promise<string> {
  const runDir = join(workDir, layout, name)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(runDir, { recursive: true })
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(join(runDir, artifact), "{}", "utf8")
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await utimes(runDir, mtime, mtime)
  return runDir
}

it("finds an upstream Strix output directory", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "lyrashield-engine-"))
  cleanupPaths.push(workDir)
  const expected = await createRun(workDir, "strix_runs", "upstream", "run.json", new Date(1_000))
  await expect(findRunOutputDir(workDir)).resolves.toBe(expected)
})

it("selects the newest valid output across both layouts", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "lyrashield-engine-"))
  cleanupPaths.push(workDir)
  await createRun(workDir, "lyrashield_runs", "legacy", "run.json", new Date(1_000))
  const expected = await createRun(
    workDir,
    "strix_runs",
    "current",
    "vulnerabilities.json",
    new Date(2_000)
  )
  await expect(findRunOutputDir(workDir)).resolves.toBe(expected)
})

it("selects only the current scan receipt when stale output is present", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "lyrashield-engine-"))
  cleanupPaths.push(workDir)
  const expected = await createRun(
    workDir,
    "lyrashield_runs",
    "scan-current",
    "run.json",
    new Date(1_000)
  )
  await createRun(workDir, "strix_runs", "scan-stale", "run.json", new Date(2_000))

  await expect(findRunOutputDir(workDir, "scan-current")).resolves.toBe(expected)
})

it("ignores newer runs whose expected artifact is a directory", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "lyrashield-engine-"))
  cleanupPaths.push(workDir)
  const expected = await createRun(workDir, "lyrashield_runs", "valid", "run.json", new Date(1_000))
  const invalidRunDir = join(workDir, "strix_runs", "invalid")
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(join(invalidRunDir, "run.json"), { recursive: true })
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await utimes(invalidRunDir, new Date(2_000), new Date(2_000))

  await expect(findRunOutputDir(workDir)).resolves.toBe(expected)
})

it("ignores directories without expected output artifacts", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "lyrashield-engine-"))
  cleanupPaths.push(workDir)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(join(workDir, "strix_runs", "empty"), { recursive: true })
  await expect(findRunOutputDir(workDir)).resolves.toBeNull()
})

describe("interpretExitCode", () => {
  it("maps exit 0 to COMPLETED", () => {
    const result = interpretExitCode(0)
    expect(result.status).toBe("COMPLETED")
    expect(result.category).toBe("SUCCESS")
  })

  it("maps exit 1 to FAILED because the engine uses it for runtime errors", () => {
    const result = interpretExitCode(1)
    expect(result.status).toBe("FAILED")
    expect(result.category).toBe("ENGINE_ERROR")
  })

  it("maps exit 2 to COMPLETED with VULNERABILITIES_FOUND", () => {
    const result = interpretExitCode(2)
    expect(result.status).toBe("COMPLETED")
    expect(result.category).toBe("VULNERABILITIES_FOUND")
  })

  it("maps exit 3 to the protected budget terminal state", () => {
    const result = interpretExitCode(3)
    expect(result.status).toBe("FAILED")
    expect(result.category).toBe("BUDGET_EXCEEDED")
    expect(result.message).toContain("protected budget")
  })

  it("maps negative exit codes to FAILED", () => {
    const result = interpretExitCode(-1)
    expect(result.status).toBe("FAILED")
    expect(result.category).toBe("ENGINE_ERROR")
  })

  it("maps exit -1 (timeout) to FAILED", () => {
    const result = interpretExitCode(-1)
    expect(result.status).toBe("FAILED")
    expect(result.message).toContain("code -1")
  })

  it("maps runtime OOM and kill signals to infrastructure errors", () => {
    expect(interpretExitCode(137).category).toBe("INFRA_ERROR")
    expect(interpretExitCode(-1, "SIGKILL").category).toBe("INFRA_ERROR")
  })
})

describe("extractEngineFailureType", () => {
  it("extracts only the fixed non-interactive exception class marker", () => {
    expect(
      extractEngineFailureType(
        "target-derived details omitted\nNon-interactive scan failed: ModelBehaviorError\ntrace omitted"
      )
    ).toBe("ModelBehaviorError")
  })

  it("rejects messages and unrelated stderr", () => {
    expect(extractEngineFailureType("Non-interactive scan failed: RuntimeError: secret")).toBe(
      "RuntimeError"
    )
    expect(extractEngineFailureType("Traceback with target-derived content")).toBeNull()
  })

  it("retains a fixed failure class before a long traceback pushes the marker out of the tail", () => {
    const first = collectEngineFailureType(
      "",
      Buffer.from("Non-interactive scan failed: ModelBehaviorError\n")
    )
    const second = collectEngineFailureType(first.window, Buffer.from("trace\n".repeat(2_000)))

    expect(first.failureType).toBe("ModelBehaviorError")
    expect(second.failureType).toBeNull()
    expect(first.failureType ?? second.failureType).toBe("ModelBehaviorError")
  })
})

describe("resolveEngineProfile", () => {
  const routingEnv = {
    LYRASHIELD_LLM: "azure/fallback",
    LYRASHIELD_LUNA_LLM: "azure/gpt-5.6-luna",
    LYRASHIELD_TERRA_LLM: "azure/gpt-5.6-terra",
  }

  it.each(["SAFE", "QUICK", "STANDARD"])("routes %s to Luna at medium reasoning", (mode) => {
    expect(resolveEngineProfile(mode, routingEnv)).toEqual({
      model: "azure/gpt-5.6-luna",
      reasoningEffort: "medium",
      delegateModel: "azure/gpt-5.6-luna",
      delegateReasoningEffort: "medium",
    })
  })

  it.each(["DEEP", "CUSTOM"])("routes %s to Terra/medium root with Luna/high delegate", (mode) => {
    expect(resolveEngineProfile(mode, routingEnv)).toEqual({
      model: "azure/gpt-5.6-terra",
      reasoningEffort: "medium",
      delegateModel: "azure/gpt-5.6-luna",
      delegateReasoningEffort: "high",
    })
  })

  it("falls back to the existing model when a routed deployment is absent", () => {
    expect(resolveEngineProfile("SAFE", { LYRASHIELD_LLM: "azure/gpt-5.6-luna" })).toEqual({
      model: "azure/gpt-5.6-luna",
      reasoningEffort: "medium",
      delegateModel: "azure/gpt-5.6-luna",
      delegateReasoningEffort: "medium",
    })
  })

  it("rejects non-GPT-5.6 deployments", () => {
    expect(() => resolveEngineProfile("SAFE", { LYRASHIELD_LLM: "azure/gpt-5.5" })).toThrow(
      "require a GPT-5.6"
    )
  })

  it("rejects GPT-5.6 Sol deployments", () => {
    expect(() => resolveEngineProfile("SAFE", { LYRASHIELD_LLM: "azure/gpt-5.6-sol" })).toThrow(
      "Terra or Luna"
    )
  })
})

describe("repository scan runtime configuration", () => {
  const runtimeEnv = {
    LYRASHIELD_LUNA_LLM: "azure/gpt-5.6-luna",
    LYRASHIELD_TERRA_LLM: "azure/gpt-5.6-terra",
    AZURE_AI_API_KEY: "test-key",
    LYRASHIELD_ENGINE_SANDBOX_NETWORK: "lyrashield-sandbox",
  }

  it("accepts a named sandbox control-plane network", () => {
    expect(resolveEngineSandboxNetwork(runtimeEnv)).toBe("lyrashield-sandbox")
    expect(() => assertRepositoryScanRuntimeConfigured(runtimeEnv)).not.toThrow()
  })

  it.each([undefined, "", "none", " NONE "])(
    "rejects an unroutable sandbox network value %s",
    (network) => {
      expect(() =>
        assertRepositoryScanRuntimeConfigured({
          ...runtimeEnv,
          LYRASHIELD_ENGINE_SANDBOX_NETWORK: network,
        })
      ).toThrow("LYRASHIELD_ENGINE_SANDBOX_NETWORK")
    }
  )

  it("requires an isolated remote Docker endpoint in production", () => {
    const productionEnv = {
      ...runtimeEnv,
      NODE_ENV: "production",
      LYRASHIELD_IMAGE: `ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:${"a".repeat(64)}`,
    }

    expect(() =>
      assertRepositoryScanRuntimeConfigured({
        ...productionEnv,
      })
    ).toThrow("DOCKER_HOST")

    expect(() =>
      assertRepositoryScanRuntimeConfigured({
        ...productionEnv,
        DOCKER_HOST: "unix:///var/run/docker.sock",
      })
    ).toThrow("DOCKER_HOST")

    expect(() =>
      assertRepositoryScanRuntimeConfigured({
        ...productionEnv,
        DOCKER_HOST: "ssh://scanner@isolated-worker",
      })
    ).not.toThrow()
  })

  it.each([
    undefined,
    "",
    "ghcr.io/ecryptoguru/lyrashield-sandbox:latest",
    `ghcr.io/usestrix/strix-sandbox@sha256:${"a".repeat(64)}`,
  ])("rejects an untrusted production sandbox image %s", (image) => {
    expect(() =>
      assertRepositoryScanRuntimeConfigured({
        ...runtimeEnv,
        NODE_ENV: "production",
        DOCKER_HOST: "ssh://scanner@isolated-worker",
        LYRASHIELD_IMAGE: image,
      })
    ).toThrow("LYRASHIELD_IMAGE")
  })
})

describe("buildEngineEnv", () => {
  const original: Record<string, string | undefined> = {}

  beforeEach(() => {
    original.LYRASHIELD_LLM = process.env.LYRASHIELD_LLM
    original.LYRASHIELD_ENGINE_SANDBOX_NETWORK = process.env.LYRASHIELD_ENGINE_SANDBOX_NETWORK
    original.LYRASHIELD_WEB_SEARCH_ENABLED = process.env.LYRASHIELD_WEB_SEARCH_ENABLED
    original.LYRASHIELD_WEB_SEARCH_API_KEY = process.env.LYRASHIELD_WEB_SEARCH_API_KEY
    original.LYRASHIELD_WEB_SEARCH_PROVIDER = process.env.LYRASHIELD_WEB_SEARCH_PROVIDER
    original.LYRASHIELD_WEB_SEARCH_MODE = process.env.LYRASHIELD_WEB_SEARCH_MODE
    original.LYRASHIELD_WEB_SEARCH_MAX_RESULTS = process.env.LYRASHIELD_WEB_SEARCH_MAX_RESULTS
    original.LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL =
      process.env.LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL
    original.LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN =
      process.env.LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN
    original.LYRASHIELD_WEB_SEARCH_BUDGET_USD = process.env.LYRASHIELD_WEB_SEARCH_BUDGET_USD
    original.LYRASHIELD_PROMPT_CACHE_EXPLICIT = process.env.LYRASHIELD_PROMPT_CACHE_EXPLICIT
    original.LYRASHIELD_PROMPT_CACHE = process.env.LYRASHIELD_PROMPT_CACHE
    process.env.LYRASHIELD_LLM = "azure/gpt-5.6-luna"
    process.env.LYRASHIELD_ENGINE_SANDBOX_NETWORK = "lyrashield-sandbox"
    // Remove all web-search variables from the live environment so these tests
    // prove buildEngineEnv's own defaults/filtration, not the local .env.
    delete process.env.LYRASHIELD_WEB_SEARCH_ENABLED
    delete process.env.LYRASHIELD_WEB_SEARCH_API_KEY
    delete process.env.LYRASHIELD_WEB_SEARCH_PROVIDER
    delete process.env.LYRASHIELD_WEB_SEARCH_MODE
    delete process.env.LYRASHIELD_WEB_SEARCH_MAX_RESULTS
    delete process.env.LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL
    delete process.env.LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN
    delete process.env.LYRASHIELD_WEB_SEARCH_BUDGET_USD
    delete process.env.LYRASHIELD_PROMPT_CACHE_EXPLICIT
    delete process.env.LYRASHIELD_PROMPT_CACHE
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it("applies web-search tuning defaults when the feature is enabled", () => {
    process.env.LYRASHIELD_WEB_SEARCH_ENABLED = "1"
    process.env.LYRASHIELD_WEB_SEARCH_API_KEY = "test-key"

    const engineEnv = buildEngineEnv({
      model: "azure/gpt-5.6-luna",
      reasoningEffort: "medium",
      delegateModel: "azure/gpt-5.6-luna",
      delegateReasoningEffort: "medium",
    })

    expect(engineEnv.LYRASHIELD_WEB_SEARCH_PROVIDER).toBe("parallel")
    expect(engineEnv.LYRASHIELD_WEB_SEARCH_MODE).toBe("turbo")
    expect(engineEnv.LYRASHIELD_WEB_SEARCH_MAX_RESULTS).toBe("5")
    expect(engineEnv.LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL).toBe("4000")
    expect(engineEnv.LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN).toBe("50")
    expect(engineEnv.LYRASHIELD_WEB_SEARCH_BUDGET_USD).toBe("1.0")
  })

  it("does not inject web-search defaults when the feature is disabled", () => {
    process.env.LYRASHIELD_WEB_SEARCH_ENABLED = "0"

    expect(process.env.LYRASHIELD_WEB_SEARCH_ENABLED).toBe("0")

    const engineEnv = buildEngineEnv({
      model: "azure/gpt-5.6-luna",
      reasoningEffort: "medium",
      delegateModel: "azure/gpt-5.6-luna",
      delegateReasoningEffort: "medium",
    })

    expect(engineEnv.LYRASHIELD_WEB_SEARCH_ENABLED).toBe("0")
    expect(engineEnv.LYRASHIELD_WEB_SEARCH_PROVIDER).toBeUndefined()
    expect(engineEnv.LYRASHIELD_WEB_SEARCH_MODE).toBeUndefined()
  })

  it("labels sandbox containers with the managed scan id", () => {
    const engineEnv = buildEngineEnv(
      {
        model: "azure/gpt-5.6-luna",
        reasoningEffort: "medium",
        delegateModel: "azure/gpt-5.6-luna",
        delegateReasoningEffort: "medium",
      },
      "scan-label"
    )

    expect(engineEnv.STRIX_RUN_ID).toBe("scan-label")
    expect(engineEnv.STRIX_RUN_TYPE).toBe("repository")
  })

  it("enables explicit GPT-5.6 prompt-cache reads and writes by default", () => {
    const engineEnv = buildEngineEnv({
      model: "azure/gpt-5.6-luna",
      reasoningEffort: "medium",
      delegateModel: "azure/gpt-5.6-luna",
      delegateReasoningEffort: "medium",
    })

    expect(engineEnv.LYRASHIELD_PROMPT_CACHE_EXPLICIT).toBe("1")
    expect(engineEnv.LYRASHIELD_PROMPT_CACHE).toBe("1")
  })
})

describe("resolveEngineTimeoutMs", () => {
  it.each(["SAFE", "QUICK", "STANDARD"])(
    "reserves scanner time within %s's fifteen-minute profile",
    (mode) => {
      expect(resolveEngineTimeoutMs(60, mode)).toBe(12 * 60 * 1000)
    }
  )

  it.each([undefined, null, 0, -1, Number.NaN])(
    "uses the Quick profile default for invalid duration %s",
    (duration) => {
      expect(resolveEngineTimeoutMs(duration, "QUICK")).toBe(12 * 60 * 1000)
    }
  )

  it("caps an excessive Quick duration at the profile limit", () => {
    expect(resolveEngineTimeoutMs(10_000, "QUICK")).toBe(12 * 60 * 1000)
  })

  it("allows Deep scans to use the forty-five-minute release limit", () => {
    expect(resolveEngineTimeoutMs(60, "DEEP")).toBe(40 * 60 * 1000)
  })
})

describe("resolveEngineSourceCheckout", () => {
  it("accepts an engine checkout below its dedicated temporary root", async () => {
    const runRoot = join(tmpdir(), "strix_repos", `runner-test-${Date.now()}`)
    const checkout = join(runRoot, "repo")
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(checkout, { recursive: true })
    cleanupPaths.push(runRoot)

    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const canonicalCheckout = await realpath(checkout)
    await expect(
      resolveEngineSourceCheckout({
        run_id: "run",
        run_name: "run",
        start_time: "now",
        end_time: null,
        status: "completed",
        targets_info: [{ details: { cloned_repo_path: checkout } }],
      })
    ).resolves.toBe(canonicalCheckout)
  })

  it("rejects a checkout path outside the engine temporary root", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "outside-strix-checkout-"))
    cleanupPaths.push(checkout)

    await expect(
      resolveEngineSourceCheckout({
        run_id: "run",
        run_name: "run",
        start_time: "now",
        end_time: null,
        status: "completed",
        targets_info: [{ details: { cloned_repo_path: checkout } }],
      })
    ).resolves.toBeNull()
  })
})

describe("resolveEngineSourceRevision", () => {
  it("records the immutable commit checked out for deterministic scanners", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "lyrashield-source-revision-"))
    cleanupPaths.push(checkout)
    execFileSync("git", ["init", checkout])
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(join(checkout, "README.md"), "scan me\n", "utf8")
    execFileSync("git", ["-C", checkout, "add", "README.md"])
    execFileSync("git", [
      "-C",
      checkout,
      "-c",
      "user.name=LyraShield test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    ])
    const expected = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim()

    await expect(resolveEngineSourceRevision(checkout)).resolves.toBe(expected)
  })
})

describe("createKillEscalation (S5)", () => {
  it("sends SIGKILL after the grace window when the process has NOT exited", () => {
    vi.useFakeTimers()
    const kills: string[] = []
    const child = { kill: (sig?: NodeJS.Signals) => (kills.push(String(sig)), true) }
    const esc = createKillEscalation(child, 5000)
    esc.onTimeout()
    expect(kills).toEqual(["SIGTERM"])
    vi.advanceTimersByTime(5000)
    expect(kills).toEqual(["SIGTERM", "SIGKILL"])
    vi.useRealTimers()
  })

  it("does NOT send SIGKILL if the process exits within the grace window", () => {
    vi.useFakeTimers()
    const kills: string[] = []
    const child = { kill: (sig?: NodeJS.Signals) => (kills.push(String(sig)), true) }
    const esc = createKillEscalation(child, 5000)
    esc.onTimeout()
    esc.markExited() // process closed before the grace window elapsed
    vi.advanceTimersByTime(5000)
    expect(kills).toEqual(["SIGTERM"])
    vi.useRealTimers()
  })
})

it("terminates every tracked engine process during worker shutdown", () => {
  const first = vi.fn()
  const second = vi.fn()
  const stopTrackingFirst = trackActiveEngineProcess(first)
  const stopTrackingSecond = trackActiveEngineProcess(second)

  expect(terminateActiveEngineProcesses()).toBe(2)
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()

  stopTrackingFirst()
  expect(terminateActiveEngineProcesses()).toBe(1)
  stopTrackingSecond()
})

it("refuses to clean a workspace outside the worker-owned run root", async () => {
  const outside = await mkdtemp(join(tmpdir(), "worker-cleanup-guard-"))
  cleanupPaths.push(outside)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(join(outside, "keep.txt"), "keep", "utf8")

  await cleanupEngineWorkspace(outside, "../outside")

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await expect(realpath(join(outside, "keep.txt"))).resolves.toMatch(/keep\.txt$/)
})

it("cleans the engine-created temporary checkout for the run", async () => {
  const runName = `cleanup-${Date.now()}`
  const workspace = join(process.cwd(), "lyrashield_runs", runName)
  const checkoutRoot = join(tmpdir(), "strix_repos", `repo_${runName}_source`)
  cleanupPaths.push(workspace, checkoutRoot)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(workspace, { recursive: true })
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(checkoutRoot, { recursive: true })

  await cleanupEngineWorkspace(workspace, runName)

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await expect(realpath(checkoutRoot)).rejects.toThrow()
})

it("clears stale receipts before a new engine attempt", async () => {
  const runName = `fresh-${Date.now()}`
  const workspace = join(process.cwd(), "lyrashield_runs", runName)
  const staleReceipt = join(workspace, "strix_runs", runName, "run.json")
  cleanupPaths.push(workspace)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(join(workspace, "strix_runs", runName), { recursive: true })
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(staleReceipt, "{}", "utf8")

  await prepareEngineWorkspace(workspace)

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await expect(realpath(staleReceipt)).rejects.toThrow()
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await expect(realpath(workspace)).resolves.toBe(workspace)
})
