/* eslint-disable security/detect-non-literal-fs-filename */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { writeFile, mkdir } from "fs/promises"
import * as fsPromises from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { rmSync } from "fs"

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { scanSast } from "./sast-scanner"

const TEST_DIR = join(tmpdir(), "lyrashield-sast-test-" + Date.now())

async function setupRepo(files: Record<string, string>): Promise<string> {
  await mkdir(TEST_DIR, { recursive: true })
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(TEST_DIR, filePath)
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"))
    await mkdir(dir, { recursive: true })
    await writeFile(fullPath, content, "utf-8")
  }
  return TEST_DIR
}

function cleanupRepo(): void {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

describe("scanSast", () => {
  beforeEach(() => {
    cleanupRepo()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanupRepo()
  })

  it("returns empty array for clean source", async () => {
    const dir = await setupRepo({
      "index.ts": "import { randomBytes } from 'crypto'\nexport const id = () => randomBytes(16)",
      "app.py": "import secrets\nTOKEN = secrets.token_urlsafe(32)",
    })
    const findings = await scanSast({ repoPath: dir, workspaceDir: dir })
    expect(findings).toEqual([])
  })

  it("flags MD5 in password context as high with control 10", async () => {
    const dir = await setupRepo({
      "auth.ts": `import { createHash } from 'crypto'\nconst passwordHash = createHash("md5").update(password).digest("hex")`,
    })
    const findings = await scanSast({ repoPath: dir, workspaceDir: dir })
    const md5 = findings.find((f) => f.id.startsWith("weak-hash-md5"))
    expect(md5).toBeDefined()
    expect(md5!.severity).toBe("high")
    expect(md5!.cwe).toBe("CWE-328")
    expect(md5!.control_ids).toEqual([10])
  })

  it("flags generic MD5 use as medium without a control mapping", async () => {
    const dir = await setupRepo({
      "util.py": "import hashlib\ndigest = hashlib.md5(payload).hexdigest()",
    })
    const findings = await scanSast({ repoPath: dir, workspaceDir: dir })
    const md5 = findings.find((f) => f.id.startsWith("weak-hash-md5"))
    expect(md5).toBeDefined()
    expect(md5!.severity).toBe("medium")
    expect(md5!.control_ids).toBeUndefined()
  })

  it("suppresses weak-hash findings for etag/checksum contexts", async () => {
    const dir = await setupRepo({
      "cache.ts": `const etag = createHash("md5").update(body).digest("hex")`,
    })
    const findings = await scanSast({ repoPath: dir, workspaceDir: dir })
    expect(findings.filter((f) => f.id.startsWith("weak-hash"))).toEqual([])
  })

  it("flags Math.random for token generation and skips UI usage", async () => {
    const dir = await setupRepo({
      "tokens.ts": `const resetToken = Math.random().toString(36).slice(2)`,
      "confetti.ts": `const delay = Math.random() * 300`,
    })
    const findings = await scanSast({ repoPath: dir, workspaceDir: dir })
    const rand = findings.find((f) => f.id.startsWith("insecure-random"))
    expect(rand).toBeDefined()
    expect(rand!.severity).toBe("high")
    expect(rand!.cwe).toBe("CWE-338")
    expect(findings.filter((f) => f.code_locations?.[0]?.file === "confetti.ts")).toEqual([])
  })

  it("flags ECB mode and disabled TLS verification as high", async () => {
    const dir = await setupRepo({
      "cipher.js": `const cipher = createCipheriv("aes-256-ecb", key, iv)`,
      "client.py": "import requests\nr = requests.get(url, verify=False)",
    })
    const findings = await scanSast({ repoPath: dir, workspaceDir: dir })
    expect(findings.find((f) => f.id.startsWith("ecb-mode"))?.severity).toBe("high")
    const tls = findings.find((f) => f.id.startsWith("verification-disabled"))
    expect(tls?.severity).toBe("high")
    expect(tls?.control_ids).toEqual([29])
  })

  it("flags JWT alg none", async () => {
    const dir = await setupRepo({
      "verify.ts": `jwt.verify(token, key, { algorithms: ["none", "RS256"] })`,
    })
    const findings = await scanSast({ repoPath: dir, workspaceDir: dir })
    const jwt = findings.find((f) => f.id.startsWith("jwt-alg-none"))
    expect(jwt).toBeDefined()
    expect(jwt!.severity).toBe("high")
    expect(jwt!.cwe).toBe("CWE-347")
  })

  it("does not flag crypto/rand usage in Go", async () => {
    const dir = await setupRepo({
      "token.go": 'import "crypto/rand"\nfunc gen() {\n\trand.Read(buf)\n}',
    })
    const findings = await scanSast({ repoPath: dir, workspaceDir: dir })
    expect(findings.filter((f) => f.id.startsWith("insecure-random"))).toEqual([])
  })

  it("flags math/rand in security context in Go", async () => {
    const dir = await setupRepo({
      "token.go": 'import "math/rand"\nfunc sessionToken() int {\n\treturn rand.Intn(1000000)\n}',
    })
    const findings = await scanSast({ repoPath: dir, workspaceDir: dir })
    expect(findings.find((f) => f.id.startsWith("insecure-random"))).toBeDefined()
  })

  it("skips test fixtures and comment lines", async () => {
    const dir = await setupRepo({
      "auth.test.ts": `const h = createHash("md5").update(password)`,
      "notes.ts": `// const h = createHash("md5").update(password)`,
    })
    const findings = await scanSast({ repoPath: dir, workspaceDir: dir })
    expect(findings).toEqual([])
  })

  it("emits a discovery receipt with file, byte, and skip accounting", async () => {
    const dir = await setupRepo({
      "index.ts": "export const a = 1",
      "app.py": "x = 2",
      "auth.test.ts": "const h = createHash('md5').update(password)",
    })
    const discovery: Record<string, unknown> = {}
    const coverageIssues: import("../scanner-coverage").ScannerCoverageIssue[] = []
    await scanSast({ repoPath: dir, workspaceDir: dir, mode: "DEEP", coverageIssues, discovery })

    const receipt = discovery.sast as {
      filesScanned: number
      bytesScanned: number
      skippedByReason: Record<string, number>
    }
    expect(receipt.filesScanned).toBe(2)
    expect(receipt.bytesScanned).toBeGreaterThan(0)
    expect(receipt.skippedByReason.testFixture).toBe(1)
    expect(receipt.skippedByReason.fileLimit).toBe(0)
  })

  it("bounds files by the mode's budget and reports the overflow", async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 210; i++)
      files[`f${String(i).padStart(4, "0")}.ts`] = `export const v${i} = ${i}`
    const dir = await setupRepo(files)

    const discovery: Record<string, unknown> = {}
    const coverageIssues: import("../scanner-coverage").ScannerCoverageIssue[] = []
    await scanSast({ repoPath: dir, workspaceDir: dir, mode: "QUICK", coverageIssues, discovery })

    const receipt = discovery.sast as {
      filesScanned: number
      skippedByReason: Record<string, number>
      representativeSkippedPaths?: string[]
    }
    expect(receipt.filesScanned).toBe(200)
    expect(receipt.skippedByReason.fileLimit).toBe(10)
    expect(receipt.representativeSkippedPaths).toContain("f0200.ts")
    expect(coverageIssues.some((issue) => issue.reason.includes("200 of 210"))).toBe(true)

    // STANDARD covers all 210 — the mode budget visibly widens coverage.
    const wide: Record<string, unknown> = {}
    await scanSast({ repoPath: dir, workspaceDir: dir, mode: "STANDARD", discovery: wide })
    expect((wide.sast as { filesScanned: number }).filesScanned).toBe(210)
  })

  it("records incomplete coverage when repository discovery fails", async () => {
    const coverageIssues: import("../scanner-coverage").ScannerCoverageIssue[] = []
    const discovery: import("../scanner-coverage").ScannerDiscovery = {}
    await scanSast({ repoPath: TEST_DIR, workspaceDir: TEST_DIR, coverageIssues, discovery })
    expect(discovery.sast?.filesScanned).toBe(0)
    expect(discovery.sast?.skippedByReason.unreadable).toBe(1)
    expect(coverageIssues).toContainEqual(
      expect.objectContaining({ scanner: "sast", status: "partial" })
    )
  })

  it("records incomplete coverage when an eligible file cannot be read", async () => {
    const dir = await setupRepo({
      "app.ts": 'const passwordHash = createHash("md5").update(password)',
    })
    vi.mocked(fsPromises.readFile).mockRejectedValueOnce(new Error("read failed"))
    const coverageIssues: import("../scanner-coverage").ScannerCoverageIssue[] = []
    const discovery: import("../scanner-coverage").ScannerDiscovery = {}
    await scanSast({ repoPath: dir, workspaceDir: dir, coverageIssues, discovery })
    expect(discovery.sast?.filesScanned).toBe(0)
    expect(discovery.sast?.skippedByReason.unreadable).toBe(1)
    expect(coverageIssues).toContainEqual(
      expect.objectContaining({ scanner: "sast", status: "partial" })
    )
  })

  it("marks per-file finding caps as bounded coverage", async () => {
    const dir = await setupRepo({
      "app.ts": Array(101)
        .fill('const passwordHash = createHash("md5").update(password)')
        .join("\n"),
    })
    const coverageIssues: import("../scanner-coverage").ScannerCoverageIssue[] = []
    const discovery: import("../scanner-coverage").ScannerDiscovery = {}
    const findings = await scanSast({ repoPath: dir, workspaceDir: dir, coverageIssues, discovery })
    expect(findings).toHaveLength(100)
    expect(discovery.sast?.skippedByReason.findingLimit).toBe(1)
    expect(coverageIssues).toContainEqual(
      expect.objectContaining({ scanner: "sast", status: "bounded", subject: "app.ts" })
    )
  })

  it("counts only inspected files after reaching the total finding cap", async () => {
    const content = Array(101)
      .fill('const passwordHash = createHash("md5").update(password)')
      .join("\n")
    const files = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [
        `app-${String(index).padStart(2, "0")}.ts`,
        content,
      ])
    )
    const dir = await setupRepo(files)
    const coverageIssues: import("../scanner-coverage").ScannerCoverageIssue[] = []
    const discovery: import("../scanner-coverage").ScannerDiscovery = {}
    const findings = await scanSast({ repoPath: dir, workspaceDir: dir, coverageIssues, discovery })
    expect(findings).toHaveLength(5000)
    expect(discovery.sast?.filesScanned).toBe(50)
    expect(discovery.sast?.bytesScanned).toBe(50 * Buffer.byteLength(content))
    expect(discovery.sast?.skippedByReason.findingLimit).toBe(51)
  })
})
