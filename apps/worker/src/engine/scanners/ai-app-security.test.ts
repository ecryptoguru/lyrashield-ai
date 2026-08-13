/* eslint-disable security/detect-non-literal-fs-filename */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdir, rm, writeFile } from "fs/promises"
import { join } from "path"
import { scanAiAppSecurity } from "./ai-app-security"

vi.mock("@lyrashield/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lyrashield/db")>()),
  queryOsvWithCache: vi.fn().mockResolvedValue({
    status: "COMPLETE",
    source: "OSV",
    requestedCount: 0,
    resolvedCount: 0,
    results: [],
    fetchedAt: "2026-08-14T00:00:00.000Z",
    snapshotId: "test",
    snapshotChecksum: "test",
    cacheAgeSeconds: 0,
    supportedEcosystems: [],
    unresolved: [],
  }),
}))

const VULNERABLE_TS = `
import OpenAI from "openai"
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function ask(userInput: string) {
  return openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: userInput }],
  })
}
`

const SAFE_TS = `
export function add(a: number, b: number) {
  return a + b
}
`

const PACKAGE_JSON = JSON.stringify({
  name: "test-app",
  dependencies: {
    lodash: "4.17.0",
  },
})

const PACKAGE_LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "node_modules/lodash": { version: "4.17.0" },
  },
})

describe("scanAiAppSecurity", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = join(process.cwd(), "tmp-ai-app-security-test", `${Date.now()}`)
    await mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("returns a prompt-injection finding for an LLM call with direct user input", async () => {
    await writeFile(join(tempDir, "ask.ts"), VULNERABLE_TS)
    const { findings } = await scanAiAppSecurity({
      repoPath: tempDir,
      workspaceDir: tempDir,
      coverageIssues: [],
    })
    const finding = findings.find((f) => f.id === "AI-01")
    expect(finding).toBeDefined()
    expect(finding?.scannerSource).toBe("ai_app_security")
    expect(finding?.remediation_steps).toMatch(/prompt-injection|sanitize/)
  })

  it("returns no findings for safe code", async () => {
    await writeFile(join(tempDir, "math.ts"), SAFE_TS)
    const { findings } = await scanAiAppSecurity({
      repoPath: tempDir,
      workspaceDir: tempDir,
      coverageIssues: [],
    })
    const ai01 = findings.find((f) => f.id === "AI-01")
    expect(ai01).toBeUndefined()
  })

  it("adds bounded direct AI data-exposure findings to the same scan result", async () => {
    await writeFile(join(tempDir, "logging.ts"), "logger.info({ prompt: request.messages })")
    const { findings } = await scanAiAppSecurity({
      repoPath: tempDir,
      workspaceDir: tempDir,
      coverageIssues: [],
    })

    expect(findings).toContainEqual(
      expect.objectContaining({ control_ids: [33, 40], scannerSource: "ai_app_security" })
    )
  })

  it("records a coverage issue for an empty repository", async () => {
    const coverage: import("../scanner-coverage").ScannerCoverageIssue[] = []
    const { findings, aiScanResult } = await scanAiAppSecurity({
      repoPath: tempDir,
      workspaceDir: tempDir,
      coverageIssues: coverage,
    })
    expect(findings).toEqual([])
    expect(aiScanResult.coverage.assessedCount).toBe(0)
    expect(coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scanner: "ai_app_security", status: "unsupported" }),
      ])
    )
  })

  it("requires an exact dependency lockfile before AI-03 can be clean", async () => {
    await writeFile(join(tempDir, "package.json"), PACKAGE_JSON)
    await writeFile(join(tempDir, "index.ts"), SAFE_TS)
    const unresolved = await scanAiAppSecurity({
      repoPath: tempDir,
      workspaceDir: tempDir,
      coverageIssues: [],
    })
    expect(unresolved.ai03Coverage).toMatchObject({ state: "INCONCLUSIVE", fresh: false })

    await writeFile(join(tempDir, "package-lock.json"), PACKAGE_LOCK)
    const resolved = await scanAiAppSecurity({
      repoPath: tempDir,
      workspaceDir: tempDir,
      coverageIssues: [],
    })
    expect(resolved.ai03Coverage).toMatchObject({
      state: "NO_FINDING",
      fresh: true,
      requestedPackages: 1,
    })
  })

  it("aborts when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      scanAiAppSecurity({
        repoPath: tempDir,
        workspaceDir: tempDir,
        coverageIssues: [],
        signal: controller.signal,
      })
    ).rejects.toThrow("AI App Security scan cancelled")
  })
})
