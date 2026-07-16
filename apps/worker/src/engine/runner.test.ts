import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, realpath, rm, utimes, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

vi.mock("@lyrashield/config", () => ({
  env: {
    LYRASHIELD_ENGINE_PATH: "",
    LYRASHIELD_IMAGE: "",
    REDIS_URL: "redis://localhost:6379",
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
  createKillEscalation,
  findRunOutputDir,
  interpretExitCode,
  resolveEngineSourceCheckout,
  resolveEngineProfile,
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

  it("maps exit 3+ to FAILED", () => {
    const result = interpretExitCode(3)
    expect(result.status).toBe("FAILED")
    expect(result.category).toBe("ENGINE_ERROR")
    expect(result.message).toContain("code 3")
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
    })
  })

  it.each(["DEEP", "CUSTOM"])("routes %s to Terra at high reasoning", (mode) => {
    expect(resolveEngineProfile(mode, routingEnv)).toEqual({
      model: "azure/gpt-5.6-terra",
      reasoningEffort: "high",
    })
  })

  it("falls back to the existing model when a routed deployment is absent", () => {
    expect(resolveEngineProfile("SAFE", { LYRASHIELD_LLM: "azure/fallback" })).toEqual({
      model: "azure/fallback",
      reasoningEffort: "medium",
    })
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
