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

  it("prioritizes production source and expands the file limit by scan mode", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true })
    await mkdir(join(tempDir, "tests", "unit"), { recursive: true })
    await writeFile(join(tempDir, "src", "z-critical.ts"), VULNERABLE_TS)
    await Promise.all(
      Array.from({ length: 216 }, (_, index) =>
        writeFile(
          join(tempDir, "tests", "unit", `${String(index).padStart(3, "0")}.test.ts`),
          SAFE_TS
        )
      )
    )

    const quickCoverage: import("../scanner-coverage").ScannerCoverageIssue[] = []
    const quick = await scanAiAppSecurity({
      repoPath: tempDir,
      workspaceDir: tempDir,
      coverageIssues: quickCoverage,
      mode: "QUICK",
    })

    expect(quick.findings).toContainEqual(expect.objectContaining({ id: "AI-01" }))
    expect(quick.discovery).toMatchObject({
      mode: "QUICK",
      maxFiles: 200,
      eligibleFiles: 217,
      scannedFiles: 200,
      skippedFiles: 17,
      skippedByReason: { fileLimit: 17 },
    })
    expect(quick.discovery.representativeSkippedPaths).toHaveLength(17)
    expect(
      quick.discovery.representativeSkippedPaths.every((filePath) =>
        filePath.startsWith(join("tests", "unit"))
      )
    ).toBe(true)
    expect(quick.aiScanResult.coverage.limitsReached).toContain("max_files")
    expect(quick.webMcpCoverage).toMatchObject({
      coverageState: "INCONCLUSIVE",
      eligibleFiles: 200,
      sourceSelection: {
        eligibleFiles: 217,
        selectedFiles: 200,
        skippedFiles: 17,
        skippedByReason: { fileLimit: 17 },
        limits: { maxFiles: 200 },
        limitsReached: ["max_files"],
      },
    })
    expect(quick.webMcpCoverage?.limitsReached).toContain("max_files")
    expect(quickCoverage).toContainEqual(
      expect.objectContaining({
        scanner: "ai_app_security",
        status: "bounded",
        metadata: expect.objectContaining({ eligibleFiles: 217, scannedFiles: 200 }),
      })
    )

    const standardCoverage: import("../scanner-coverage").ScannerCoverageIssue[] = []
    const standard = await scanAiAppSecurity({
      repoPath: tempDir,
      workspaceDir: tempDir,
      coverageIssues: standardCoverage,
      mode: "STANDARD",
    })

    expect(standard.discovery).toMatchObject({
      mode: "STANDARD",
      maxFiles: 500,
      eligibleFiles: 217,
      scannedFiles: 217,
      skippedFiles: 0,
    })
    expect(standard.aiScanResult.coverage.limitsReached).not.toContain("max_files")
    expect(standard.webMcpCoverage).toMatchObject({
      coverageState: "COMPLETE",
      sourceSelection: {
        eligibleFiles: 217,
        selectedFiles: 217,
        skippedFiles: 0,
        limitsReached: [],
      },
    })
    expect(standardCoverage.some((issue) => issue.status === "bounded")).toBe(false)
  })

  it("excludes generated and browser-test artifact directories", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true })
    await mkdir(join(tempDir, ".vercel", "output"), { recursive: true })
    await mkdir(join(tempDir, ".playwright-mcp"), { recursive: true })
    await mkdir(join(tempDir, "test-results"), { recursive: true })
    await writeFile(join(tempDir, "src", "index.ts"), SAFE_TS)
    await writeFile(join(tempDir, ".vercel", "output", "config.json"), "{}")
    await writeFile(join(tempDir, ".playwright-mcp", "state.json"), "{}")
    await writeFile(join(tempDir, "test-results", "results.json"), "{}")

    const result = await scanAiAppSecurity({
      repoPath: tempDir,
      workspaceDir: tempDir,
      coverageIssues: [],
      mode: "QUICK",
    })

    expect(result.discovery).toMatchObject({
      eligibleFiles: 1,
      scannedFiles: 1,
      skippedFiles: 0,
    })
  })

  it("includes HTML, Astro, module, and WebMCP header sources", async () => {
    await writeFile(
      join(tempDir, "tool.html"),
      `<form toolname="delete_account" tooldescription="Delete account" method="post" toolautosubmit></form>`
    )
    await writeFile(
      join(tempDir, "tool.astro"),
      `<script>document.modelContext.registerTool({ name: "remove", inputSchema: { type: "object", properties: {} }, execute: () => fetch("/x", { method: "DELETE" }) }, { exposedTo: ["*"] })</script>`
    )
    await writeFile(
      join(tempDir, "tool.mjs"),
      `document.modelContext.registerTool({ name: "read", inputSchema: { type: "object", properties: {} }, execute: () => ({ ok: true }) })`
    )
    await writeFile(join(tempDir, "_headers"), "Permissions-Policy: tools=(*)")

    const result = await scanAiAppSecurity({
      repoPath: tempDir,
      workspaceDir: tempDir,
      coverageIssues: [],
    })

    expect(result.discovery.eligibleFiles).toBe(4)
    expect(result.webMcpCoverage).toMatchObject({
      coverageState: "COMPLETE",
      eligibleFiles: 4,
      scannedFiles: 4,
      toolDefinitionsFound: 3,
      imperativeDefinitions: 2,
      declarativeDefinitions: 1,
      sourceSelection: {
        eligibleFiles: 4,
        selectedFiles: 4,
        skippedFiles: 0,
      },
    })
    expect(result.webMcpCoverage?.scannedBytes).toBeGreaterThan(0)
    expect(result.webMcpFindings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining(["WEBMCP-03", "WEBMCP-04", "WEBMCP-05"])
    )
  })

  it("records incomplete WebMCP discovery as partial coverage", async () => {
    await writeFile(join(tempDir, "dynamic.ts"), "document.modelContext.registerTool(buildTool())")
    const coverage: import("../scanner-coverage").ScannerCoverageIssue[] = []

    const result = await scanAiAppSecurity({
      repoPath: tempDir,
      workspaceDir: tempDir,
      coverageIssues: coverage,
    })

    expect(result.webMcpCoverage?.incompleteDefinitions).toBe(1)
    expect(result.webMcpCoverage?.coverageState).toBe("INCONCLUSIVE")
    expect(coverage).toContainEqual(
      expect.objectContaining({ scanner: "ai_app_security", status: "partial" })
    )
  })

  it("counts only WebMCP-scannable files in receipt bytes", async () => {
    const webMcpSource = `document.modelContext.registerTool({ name: "read", inputSchema: { type: "object", properties: {} }, execute: () => ({ ok: true }) })`
    const unsupportedSource = "print('not a WebMCP source')"
    await writeFile(join(tempDir, "tool.ts"), webMcpSource)
    await writeFile(join(tempDir, "other.py"), unsupportedSource)

    const result = await scanAiAppSecurity({
      repoPath: tempDir,
      workspaceDir: tempDir,
      coverageIssues: [],
    })

    expect(result.webMcpCoverage).toMatchObject({
      coverageState: "COMPLETE",
      eligibleFiles: 1,
      scannedFiles: 1,
      scannedBytes: Buffer.byteLength(webMcpSource),
      sourceSelection: {
        eligibleFiles: 2,
        selectedFiles: 2,
        skippedFiles: 0,
        scannedBytes: Buffer.byteLength(webMcpSource) + Buffer.byteLength(unsupportedSource),
      },
    })
    expect(result.webMcpCoverage?.limitsReached).not.toContain("unsupported_language")
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
