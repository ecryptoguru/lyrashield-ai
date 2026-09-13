/* eslint-disable security/detect-non-literal-fs-filename */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { rmSync } from "fs"

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
})
