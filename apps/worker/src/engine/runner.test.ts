import { execFileSync } from "child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { createHash } from "crypto"
import { parseEngineOutput } from "./output-parser"

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
  parseEngineProgressFingerprint,
  readEngineProgressFingerprint,
  readEngineSpendUsd,
  readEngineOutput,
  createEngineStreamTail,
  appendEngineStreamTail,
  flushEngineStreamTail,
  redactEngineTailLine,
  ENGINE_TAIL_MAX_LINES,
  ENGINE_TAIL_MAX_CHARS,
  OVERSHOOT_GRACE,
  terminateActiveEngineProcesses,
  trackActiveEngineProcess,
  runEngine,
} from "./runner"
import { addScanEvent } from "@lyrashield/db"
import { env } from "@lyrashield/config"

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

it("reads the owned singular threat-model artifact before any legacy plural file", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "lyrashield-owned-evidence-"))
  cleanupPaths.push(outputDir)
  const canonical = JSON.stringify({
    schema_version: "lyrashield-threat-model/1.0",
    run_id: "scan-1",
    models: [],
  })
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(join(outputDir, "threat_model.json"), canonical, "utf8")
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(join(outputDir, "threat_models.json"), "{}", "utf8")
  // Canonical evidence is bound to the producer's run manifest.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(
    join(outputDir, "run.json"),
    JSON.stringify({
      schema_version: "1.1",
      run_id: "scan-1",
      result_manifest: {
        schema_version: 1,
        artifacts: {
          "threat_model.json": {
            path: "threat_model.json",
            bytes: Buffer.byteLength(canonical),
            sha256: createHash("sha256").update(canonical).digest("hex"),
          },
        },
      },
    })
  )

  const output = await readEngineOutput(outputDir)

  expect(output.artifacts.threatModelsRaw).toBe(canonical)
})

/* eslint-disable security/detect-non-literal-fs-filename -- This test reads a fixed fixture and writes only to its own temporary directory. */
it("round-trips an actual redacted engine writer artifact through the manifest-bound reader", async () => {
  // Produced by build_threat_model_document + write_threat_model_artifact in
  // lyrashield-engine; unlike synthetic models: [] fixtures, it exercises the
  // writer's model-array, amendment, target-redaction and run binding shape.
  const canonical = await readFile(
    new URL("./fixtures/run-json-1.1/threat_model.json", import.meta.url),
    "utf8"
  )
  const runRecord = JSON.parse(
    await readFile(new URL("./fixtures/run-json-1.1/run.json", import.meta.url), "utf8")
  )
  const outputDir = await mkdtemp(join(tmpdir(), "lyrashield-writer-fixture-"))
  cleanupPaths.push(outputDir)
  await writeFile(join(outputDir, "threat_model.json"), canonical, "utf8")
  await writeFile(
    join(outputDir, "run.json"),
    JSON.stringify({
      ...runRecord,
      result_manifest: {
        schema_version: 1,
        artifacts: {
          "threat_model.json": {
            path: "threat_model.json",
            bytes: Buffer.byteLength(canonical),
            sha256: createHash("sha256").update(canonical).digest("hex"),
          },
        },
      },
    })
  )

  const output = await readEngineOutput(outputDir)
  const parsed = parseEngineOutput(output.vulnerabilitiesRaw, output.runJsonRaw, output.artifacts)
  expect(output.artifacts.threatModelsRaw).toBe(canonical)
  expect(parsed.threatModels?.models).toHaveLength(1)
  expect(JSON.stringify(parsed.threatModels)).toContain("[SECRET]")
  expect(JSON.stringify(parsed.threatModels)).not.toContain("sample-secret-123")
})
/* eslint-enable security/detect-non-literal-fs-filename */

it("rejects an unbound canonical threat model without a 1.1 run receipt", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "lyrashield-unbound-evidence-"))
  cleanupPaths.push(outputDir)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(join(outputDir, "threat_model.json"), JSON.stringify({ models: [] }))
  const output = await readEngineOutput(outputDir)
  expect(output.artifacts.threatModelsRaw).toBeNull()
})

it("does not import a plural-only legacy artifact into a 1.1 run", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "lyrashield-plural-only-"))
  cleanupPaths.push(outputDir)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(join(outputDir, "run.json"), JSON.stringify({ schema_version: "1.1" }))
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(
    join(outputDir, "threat_models.json"),
    JSON.stringify({ stale: { target: "other-run", content: "unbound" } })
  )
  const output = await readEngineOutput(outputDir)
  expect(output.artifacts.threatModelsRaw).toBeUndefined()
})

it("retains the plural adapter for a pre-1.1 run", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "lyrashield-legacy-plural-"))
  cleanupPaths.push(outputDir)
  const legacy = JSON.stringify({ old: { target: "legacy", content: "context" } })
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(join(outputDir, "run.json"), JSON.stringify({ schema_version: "1.0" }))
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(join(outputDir, "threat_models.json"), legacy)
  const output = await readEngineOutput(outputDir)
  expect(output.artifacts.threatModelsRaw).toBe(legacy)
})

it("rejects a threat model that is missing or differs from the run manifest", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "lyrashield-manifest-evidence-"))
  cleanupPaths.push(outputDir)
  const canonical = JSON.stringify({
    schema_version: "lyrashield-threat-model/1.0",
    run_id: "scan-1",
    models: [],
  })
  const manifest = {
    schema_version: 1,
    artifacts: {
      "threat_model.json": {
        path: "threat_model.json",
        bytes: Buffer.byteLength(canonical),
        sha256: createHash("sha256").update(canonical).digest("hex"),
      },
    },
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(
    join(outputDir, "run.json"),
    JSON.stringify({ schema_version: "1.1", run_id: "scan-1", result_manifest: manifest })
  )
  // A stale pre-contract sibling must never fill a missing 1.1 artifact.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(
    join(outputDir, "threat_models.json"),
    JSON.stringify({ stale: { target: "other-run", content: "unbound" } })
  )

  const missing = await readEngineOutput(outputDir)
  expect(missing.artifacts.threatModelsRaw).toBeNull()
  expect(
    parseEngineOutput(missing.vulnerabilitiesRaw, missing.runJsonRaw, missing.artifacts)
      .ingestionIssues
  ).toContain("threat_model.json unreadable or oversized — artifact ignored")

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(join(outputDir, "threat_model.json"), canonical.replace("scan-1", "scan-2"))
  const changed = await readEngineOutput(outputDir)
  expect(changed.artifacts.threatModelsRaw).toBeNull()

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(join(outputDir, "threat_model.json"), canonical)
  const valid = await readEngineOutput(outputDir)
  expect(valid.artifacts.threatModelsRaw).toBe(canonical)
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
    LYRASHIELD_LUNA_LLM: "azure/gpt-6-luna",
    LYRASHIELD_SOL_LLM: "azure/gpt-6-sol",
  }

  it.each(["SAFE", "QUICK", "STANDARD"])("routes %s to Luna at medium reasoning", (mode) => {
    expect(resolveEngineProfile(mode, routingEnv)).toEqual({
      model: "azure/gpt-6-luna",
      reasoningEffort: "medium",
      delegateModel: "azure/gpt-6-luna",
      delegateReasoningEffort: "medium",
    })
  })

  it.each(["DEEP", "CUSTOM"])("routes %s to Sol/medium root with Luna/high delegate", (mode) => {
    expect(resolveEngineProfile(mode, routingEnv)).toEqual({
      model: "azure/gpt-6-sol",
      reasoningEffort: "medium",
      delegateModel: "azure/gpt-6-luna",
      delegateReasoningEffort: "high",
    })
  })

  it("falls back to the existing model when a routed deployment is absent", () => {
    expect(resolveEngineProfile("SAFE", { LYRASHIELD_LLM: "azure/gpt-6-luna" })).toEqual({
      model: "azure/gpt-6-luna",
      reasoningEffort: "medium",
      delegateModel: "azure/gpt-6-luna",
      delegateReasoningEffort: "medium",
    })
  })

  it("fails closed when Deep lacks a distinct Sol root", () => {
    expect(() => resolveEngineProfile("DEEP", { LYRASHIELD_LLM: "azure/gpt-6-luna" })).toThrow(
      "LYRASHIELD_SOL_LLM"
    )
  })

  it("rejects non-GPT-6 deployments", () => {
    expect(() => resolveEngineProfile("SAFE", { LYRASHIELD_LLM: "azure/gpt-5.5" })).toThrow(
      "require a GPT-6"
    )
  })

  it("rejects GPT-5.6 Sol deployments", () => {
    expect(() => resolveEngineProfile("SAFE", { LYRASHIELD_LLM: "azure/gpt-5.6-sol" })).toThrow(
      "Sol or Luna"
    )
  })

  it.each(["evil/azure/gpt-6-luna", "azure/gpt-6-luna.evil"])(
    "rejects a misleading provider route %s",
    (model) => {
      expect(() => resolveEngineProfile("SAFE", { LYRASHIELD_LLM: model })).toThrow(
        "require a GPT-6"
      )
    }
  )
})

describe("repository scan runtime configuration", () => {
  const runtimeEnv = {
    LYRASHIELD_LUNA_LLM: "azure/gpt-6-luna",
    LYRASHIELD_SOL_LLM: "azure/gpt-6-sol",
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

  it("requires an isolated remote Docker endpoint in production by default", () => {
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

  it("accepts a local Docker daemon only with the explicit single-VM opt-in", () => {
    const productionEnv = {
      ...runtimeEnv,
      NODE_ENV: "production",
      LYRASHIELD_IMAGE: `ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:${"a".repeat(64)}`,
      LYRASHIELD_ENGINE_SANDBOX_NETWORK: "lyrashield-sandbox",
    }

    // Without the opt-in, a local socket still fails (strict default preserved).
    expect(() =>
      assertRepositoryScanRuntimeConfigured({
        ...productionEnv,
        DOCKER_HOST: "unix:///var/run/docker.sock",
      })
    ).toThrow("DOCKER_HOST")

    // With the explicit opt-in AND a named egress-restricted network, local
    // Docker is accepted (the single-VM + firewall topology).
    expect(() =>
      assertRepositoryScanRuntimeConfigured({
        ...productionEnv,
        DOCKER_HOST: "unix:///var/run/docker.sock",
        LYRASHIELD_ALLOW_LOCAL_SANDBOX_HOST: "1",
      })
    ).not.toThrow()

    // The opt-in never rescues a missing egress-restricted network.
    expect(() =>
      assertRepositoryScanRuntimeConfigured({
        ...productionEnv,
        DOCKER_HOST: "unix:///var/run/docker.sock",
        LYRASHIELD_ALLOW_LOCAL_SANDBOX_HOST: "1",
        LYRASHIELD_ENGINE_SANDBOX_NETWORK: "",
      })
    ).toThrow("LYRASHIELD_ENGINE_SANDBOX_NETWORK")
  })

  it.each([
    undefined,
    "",
    "ghcr.io/ecryptoguru/lyrashield-sandbox:latest",
    `ghcr.io/usestrix/strix-sandbox@sha256:${"a".repeat(64)}`,
    ` ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:${"a".repeat(64)} `,
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
    process.env.LYRASHIELD_LLM = "azure/gpt-6-luna"
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
      model: "azure/gpt-6-luna",
      reasoningEffort: "medium",
      delegateModel: "azure/gpt-6-luna",
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
      model: "azure/gpt-6-luna",
      reasoningEffort: "medium",
      delegateModel: "azure/gpt-6-luna",
      delegateReasoningEffort: "medium",
    })

    expect(engineEnv.LYRASHIELD_WEB_SEARCH_ENABLED).toBe("0")
    expect(engineEnv.LYRASHIELD_WEB_SEARCH_PROVIDER).toBeUndefined()
    expect(engineEnv.LYRASHIELD_WEB_SEARCH_MODE).toBeUndefined()
  })

  it("labels sandbox containers with the managed scan id", () => {
    const engineEnv = buildEngineEnv(
      {
        model: "azure/gpt-6-luna",
        reasoningEffort: "medium",
        delegateModel: "azure/gpt-6-luna",
        delegateReasoningEffort: "medium",
      },
      "scan-label"
    )

    expect(engineEnv.STRIX_RUN_ID).toBe("scan-label")
    expect(engineEnv.STRIX_RUN_TYPE).toBe("repository")
  })

  it("enables explicit GPT-5.6 prompt-cache reads and writes by default", () => {
    const engineEnv = buildEngineEnv({
      model: "azure/gpt-6-luna",
      reasoningEffort: "medium",
      delegateModel: "azure/gpt-6-luna",
      delegateReasoningEffort: "medium",
    })

    expect(engineEnv.LYRASHIELD_PROMPT_CACHE_EXPLICIT).toBe("1")
    expect(engineEnv.LYRASHIELD_PROMPT_CACHE).toBe("1")
  })

  it("keeps engine checkouts on the worker's host-visible temporary root", () => {
    const engineEnv = buildEngineEnv({
      model: "azure/gpt-6-luna",
      reasoningEffort: "medium",
      delegateModel: "azure/gpt-6-luna",
      delegateReasoningEffort: "medium",
    })

    expect(engineEnv.TMPDIR).toBe(tmpdir())
  })
})

describe("readEngineProgressFingerprint", () => {
  it("reads only the bounded monotonic progress fields from the active run receipt", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "lyrashield-engine-"))
    cleanupPaths.push(workDir)
    const runDir = await createRun(
      workDir,
      "strix_runs",
      "scan-progress",
      "run.json",
      new Date(1_000)
    )
    // runDir is created in the worker-owned temporary test workspace above.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({ seq: 7, turn_count: 4, phase: "running", instruction: "must not leak" }),
      "utf8"
    )

    await expect(readEngineProgressFingerprint(workDir, "scan-progress")).resolves.toBe(
      "7:4:running"
    )
  })

  it("does not treat malformed or incomplete receipts as progress", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "lyrashield-engine-"))
    cleanupPaths.push(workDir)
    const runDir = await createRun(
      workDir,
      "strix_runs",
      "scan-progress",
      "run.json",
      new Date(1_000)
    )
    // runDir is created in the worker-owned temporary test workspace above.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({ seq: "7", phase: "running" }),
      "utf8"
    )

    await expect(readEngineProgressFingerprint(workDir, "scan-progress")).resolves.toBeNull()
  })
})

describe("readEngineSpendUsd", () => {
  it("reads the live cumulative llm_usage.cost from the active run receipt", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "lyrashield-engine-"))
    cleanupPaths.push(workDir)
    const runDir = await createRun(workDir, "strix_runs", "scan-spend", "run.json", new Date(1_000))
    // runDir is created in the worker-owned temporary test workspace above.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({ seq: 3, turn_count: 2, phase: "running", llm_usage: { cost: 0.84 } }),
      "utf8"
    )

    await expect(readEngineSpendUsd(workDir, "scan-spend")).resolves.toBeCloseTo(0.84)
  })

  it("returns null when llm_usage is absent (fail-open on read)", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "lyrashield-engine-"))
    cleanupPaths.push(workDir)
    const runDir = await createRun(workDir, "strix_runs", "scan-spend", "run.json", new Date(1_000))
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({ seq: 0, turn_count: 0, phase: "setup" }),
      "utf8"
    )

    await expect(readEngineSpendUsd(workDir, "scan-spend")).resolves.toBeNull()
  })

  it("returns null when llm_usage.cost is malformed (fail-open on read)", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "lyrashield-engine-"))
    cleanupPaths.push(workDir)
    const runDir = await createRun(workDir, "strix_runs", "scan-spend", "run.json", new Date(1_000))
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        seq: 1,
        turn_count: 1,
        phase: "running",
        llm_usage: { cost: "not-a-number" },
      }),
      "utf8"
    )

    await expect(readEngineSpendUsd(workDir, "scan-spend")).resolves.toBeNull()
  })

  it("returns null when the run output directory does not exist", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "lyrashield-engine-"))
    cleanupPaths.push(workDir)

    await expect(readEngineSpendUsd(workDir, "no-such-run")).resolves.toBeNull()
  })

  it("returns null when run.json is not valid JSON", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "lyrashield-engine-"))
    cleanupPaths.push(workDir)
    const runDir = await createRun(workDir, "strix_runs", "scan-spend", "run.json", new Date(1_000))
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(join(runDir, "run.json"), "{ broken json", "utf8")

    await expect(readEngineSpendUsd(workDir, "scan-spend")).resolves.toBeNull()
  })

  it("returns null for a negative cost (fail-open on read, never over-budget)", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "lyrashield-engine-"))
    cleanupPaths.push(workDir)
    const runDir = await createRun(workDir, "strix_runs", "scan-spend", "run.json", new Date(1_000))
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({ seq: 1, turn_count: 1, phase: "running", llm_usage: { cost: -0.5 } }),
      "utf8"
    )

    await expect(readEngineSpendUsd(workDir, "scan-spend")).resolves.toBeNull()
  })
})

describe("OVERSHOOT_GRACE", () => {
  it("is the founder-tunable 7.5% grace margin", () => {
    expect(OVERSHOOT_GRACE).toBe(0.075)
  })
})

describe("resolveEngineSourceCheckout", () => {
  it("accepts an engine checkout below its dedicated temporary root", async () => {
    const scanId = `runner-test-${Date.now()}`
    const runRoot = join(tmpdir(), "strix_repos", `repo_${scanId}_source`)
    const checkout = join(runRoot, "repo")
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(checkout, { recursive: true })
    cleanupPaths.push(runRoot)

    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const canonicalCheckout = await realpath(checkout)
    await expect(
      resolveEngineSourceCheckout(
        {
          run_id: scanId,
          run_name: scanId,
          start_time: "now",
          end_time: null,
          status: "completed",
          targets_info: [{ details: { cloned_repo_path: checkout } }],
        },
        scanId
      )
    ).resolves.toBe(canonicalCheckout)
  })

  it("recovers the scan-owned checkout when public run.json redacts its path", async () => {
    const scanId = `sanitized-${Date.now()}`
    const runRoot = join(tmpdir(), "strix_repos", `repo_${scanId}_source`)
    const checkout = join(runRoot, "repo")
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(checkout, { recursive: true })
    cleanupPaths.push(runRoot)

    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const canonicalCheckout = await realpath(checkout)
    await expect(
      resolveEngineSourceCheckout(
        {
          run_id: scanId,
          run_name: scanId,
          start_time: "now",
          end_time: null,
          status: "completed",
          targets_info: [],
        },
        scanId
      )
    ).resolves.toBe(canonicalCheckout)
  })

  it("fails closed when multiple checkout roots claim the same scan", async () => {
    const scanId = `ambiguous-${Date.now()}`
    const first = join(tmpdir(), "strix_repos", `repo_${scanId}_first`)
    const second = join(tmpdir(), "strix_repos", `repo_${scanId}_second`)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(join(first, "repo"), { recursive: true })
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(join(second, "repo"), { recursive: true })
    cleanupPaths.push(first, second)

    await expect(
      resolveEngineSourceCheckout(
        {
          run_id: scanId,
          run_name: scanId,
          start_time: "now",
          end_time: null,
          status: "completed",
          targets_info: [],
        },
        scanId
      )
    ).resolves.toBeNull()
  })

  it("fails closed when a scan-owned root has multiple checkout directories", async () => {
    const scanId = `children-${Date.now()}`
    const runRoot = join(tmpdir(), "strix_repos", `repo_${scanId}_source`)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(join(runRoot, "first"), { recursive: true })
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(join(runRoot, "second"), { recursive: true })
    cleanupPaths.push(runRoot)

    await expect(
      resolveEngineSourceCheckout(
        {
          run_id: scanId,
          run_name: scanId,
          start_time: "now",
          end_time: null,
          status: "completed",
          targets_info: [],
        },
        scanId
      )
    ).resolves.toBeNull()
  })

  it("rejects a checkout when the durable receipt belongs to another scan", async () => {
    const scanId = `receipt-${Date.now()}`
    const runRoot = join(tmpdir(), "strix_repos", `repo_${scanId}_source`)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(join(runRoot, "repo"), { recursive: true })
    cleanupPaths.push(runRoot)

    await expect(
      resolveEngineSourceCheckout(
        {
          run_id: "another-scan",
          run_name: "another-scan",
          start_time: "now",
          end_time: null,
          status: "completed",
          targets_info: [],
        },
        scanId
      )
    ).resolves.toBeNull()
  })

  it("rejects invalid scan IDs before checkout discovery", async () => {
    const runRecord = {
      run_id: "../run",
      run_name: "../run",
      start_time: "now",
      end_time: null,
      status: "completed",
      targets_info: [],
    }

    await expect(resolveEngineSourceCheckout(runRecord, "../run")).resolves.toBeNull()
    await expect(resolveEngineSourceCheckout(runRecord, "..")).resolves.toBeNull()
  })

  it("rejects a symlinked checkout", async () => {
    const scanId = `symlink-${Date.now()}`
    const runRoot = join(tmpdir(), "strix_repos", `repo_${scanId}_source`)
    const outside = await mkdtemp(join(tmpdir(), "outside-strix-symlink-"))
    const checkout = join(runRoot, "repo")
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(runRoot, { recursive: true })
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await symlink(outside, checkout)
    cleanupPaths.push(runRoot, outside)

    await expect(
      resolveEngineSourceCheckout(
        {
          run_id: scanId,
          run_name: scanId,
          start_time: "now",
          end_time: null,
          status: "completed",
          targets_info: [{ details: { cloned_repo_path: checkout } }],
        },
        scanId
      )
    ).resolves.toBeNull()
  })

  it("rejects a checkout path outside the engine temporary root", async () => {
    const scanId = `outside-${Date.now()}`
    const checkout = await mkdtemp(join(tmpdir(), "outside-strix-checkout-"))
    cleanupPaths.push(checkout)

    await expect(
      resolveEngineSourceCheckout(
        {
          run_id: scanId,
          run_name: scanId,
          start_time: "now",
          end_time: null,
          status: "completed",
          targets_info: [{ details: { cloned_repo_path: checkout } }],
        },
        scanId
      )
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

it("does not emit engine_start when cancellation already won", async () => {
  vi.mocked(addScanEvent).mockClear()

  const result = await runEngine(
    {
      scanId: "scan-cancelled",
      goal: "TEST_APP",
      mode: "SAFE",
      target: {
        id: "target-1",
        type: "REPO",
        repoFullName: "acme/repo",
        name: "Repository",
      },
    },
    "scan-cancelled",
    60_000,
    async () => true
  )

  expect(result).toMatchObject({ exitCode: -1, cancelled: true })
  expect(addScanEvent).not.toHaveBeenCalled()
})

/* eslint-disable security/detect-non-literal-fs-filename -- Paths are confined to this test's private temporary directory. */
it("terminates a running engine after cancellation and escalates an ignored SIGTERM", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "lyrashield-cancel-child-"))
  const script = join(fixture, "engine.mjs")
  const started = join(fixture, "started")
  const signal = join(fixture, "signal")
  const scanId = `cancel-child-${Date.now()}`
  const workspace = join(process.cwd(), "lyrashield_runs", scanId)
  cleanupPaths.push(fixture, workspace)
  // The real process ignores SIGTERM; the worker must send SIGKILL after grace.
  await writeFile(
    script,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(started)}, 'ready')\nprocess.on('SIGTERM', () => writeFileSync(${JSON.stringify(signal)}, 'SIGTERM'))\nsetInterval(() => {}, 1000)\n`,
    "utf8"
  )
  await chmod(script, 0o700)
  const runtimeEnv = env as { LYRASHIELD_ENGINE_PATH: string }
  const previousEnginePath = runtimeEnv.LYRASHIELD_ENGINE_PATH
  const previousLuna = process.env.LYRASHIELD_LUNA_LLM
  const previousNetwork = process.env.LYRASHIELD_ENGINE_SANDBOX_NETWORK
  runtimeEnv.LYRASHIELD_ENGINE_PATH = script
  process.env.LYRASHIELD_LUNA_LLM = "openai/gpt-6-luna"
  process.env.LYRASHIELD_ENGINE_SANDBOX_NETWORK = "test-egress"
  let cancelled = false
  try {
    const run = runEngine(
      {
        scanId,
        goal: "TEST_APP",
        mode: "SAFE",
        target: { id: "target-1", type: "REPO", repoFullName: "acme/repo", name: "Repository" },
      },
      scanId,
      30_000,
      async () => cancelled
    )
    await vi.waitFor(async () => expect(await readFile(started, "utf8")).toBe("ready"), {
      timeout: 5000,
    })
    cancelled = true
    const result = await run
    expect(result).toMatchObject({ exitCode: -1, cancelled: true, timedOut: false })
    expect(await readFile(signal, "utf8")).toBe("SIGTERM")
    expect(terminateActiveEngineProcesses()).toBe(0)
  } finally {
    runtimeEnv.LYRASHIELD_ENGINE_PATH = previousEnginePath
    if (previousLuna === undefined) delete process.env.LYRASHIELD_LUNA_LLM
    else process.env.LYRASHIELD_LUNA_LLM = previousLuna
    if (previousNetwork === undefined) delete process.env.LYRASHIELD_ENGINE_SANDBOX_NETWORK
    else process.env.LYRASHIELD_ENGINE_SANDBOX_NETWORK = previousNetwork
    terminateActiveEngineProcesses()
  }
}, 12_000)
/* eslint-enable security/detect-non-literal-fs-filename */

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

describe("parseEngineProgressFingerprint", () => {
  it("round-trips the liveness fields readEngineProgressFingerprint emits", () => {
    expect(parseEngineProgressFingerprint("12:34:running")).toEqual({
      seq: 12,
      turnCount: 34,
      phase: "running",
    })
    expect(parseEngineProgressFingerprint("0:0:setup")).toEqual({
      seq: 0,
      turnCount: 0,
      phase: "setup",
    })
  })

  it("rejects malformed fingerprints instead of guessing", () => {
    expect(parseEngineProgressFingerprint("12:34")).toBeNull()
    expect(parseEngineProgressFingerprint("12:34:running:extra")).toBeNull()
    expect(parseEngineProgressFingerprint("a:34:running")).toBeNull()
    expect(parseEngineProgressFingerprint("12:-1:running")).toBeNull()
    expect(parseEngineProgressFingerprint("12:34:unknown-phase")).toBeNull()
  })
})

describe("engine stream tail capture (failure diagnosis without log exposure)", () => {
  it("keeps only the last lines and stays bounded", () => {
    const tail = createEngineStreamTail()
    for (let i = 1; i <= 120; i++) {
      appendEngineStreamTail(tail, Buffer.from(`line ${i}\n`))
    }
    // "line 120\n" leaves no pending segment — everything landed as lines.
    expect(tail.pending).toBe("")
    expect(tail.lines.length).toBeLessThanOrEqual(ENGINE_TAIL_MAX_LINES)
    expect(tail.chars).toBeLessThanOrEqual(ENGINE_TAIL_MAX_CHARS)
    expect(tail.lines.at(-1)).toBe("line 120")
    // The oldest lines were dropped — only the tail survives.
    expect(tail.lines).not.toContain("line 1")
  })

  it("assembles a line split across chunk boundaries (no phantom partials)", () => {
    const tail = createEngineStreamTail()
    appendEngineStreamTail(tail, Buffer.from("start of li"))
    // The first chunk has no newline — nothing is recorded yet.
    expect(tail.lines).toEqual([])
    expect(tail.pending).toBe("start of li")
    appendEngineStreamTail(tail, Buffer.from("ne\nsecond line\n"))
    expect(tail.lines).toEqual(["start of line", "second line"])
    expect(tail.pending).toBe("")
  })

  it("flushes a trailing partial line once, at close time", () => {
    const tail = createEngineStreamTail()
    appendEngineStreamTail(tail, Buffer.from("first line\nno trailing newline yet"))
    expect(tail.lines).toEqual(["first line"])
    expect(tail.pending).toBe("no trailing newline yet")
    flushEngineStreamTail(tail)
    expect(tail.lines).toEqual(["first line", "no trailing newline yet"])
    expect(tail.pending).toBe("")
    // Idempotent: a second flush has nothing to emit.
    flushEngineStreamTail(tail)
    expect(tail.lines).toEqual(["first line", "no trailing newline yet"])
  })

  it("redacts secret-shaped values before persistence", () => {
    // Fixtures are assembled from low-entropy fragments so the secret scanner
    // does not flag the test source itself (a literal high-entropy-looking
    // token here previously tripped gitleaks' generic-api-key rule).
    const fakeQuoted = ["sk-test", "0123456789", "testtest"].join("-")
    const fakeAssigned = ["AKIA", "TESTTEST", "TESTTEST12"].join("")
    expect(redactEngineTailLine(`export API_KEY="${fakeQuoted}"`)).toBe(
      'export API_KEY="***REDACTED***"'
    )
    expect(redactEngineTailLine(`api_key=${fakeAssigned}`)).toBe("api_key=***REDACTED***")
    expect(redactEngineTailLine("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6")).toBe(
      "Authorization: Bearer ***REDACTED***"
    )
    // Ordinary engine output is untouched.
    expect(redactEngineTailLine("Cloning repository from https://github.com/acme/app.git")).toBe(
      "Cloning repository from https://github.com/acme/app.git"
    )
    expect(redactEngineTailLine("token=abc123")).toBe("token=abc123")
  })
})
