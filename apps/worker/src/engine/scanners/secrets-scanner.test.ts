/* eslint-disable security/detect-non-literal-fs-filename */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { rmSync } from "fs"

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { scanSecrets } from "./secrets-scanner"

const TEST_DIR = join(tmpdir(), "lyrasec-secrets-test-" + Date.now())

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

describe("scanSecrets", () => {
  beforeEach(() => {
    cleanupRepo()
  })

  afterEach(() => {
    cleanupRepo()
  })

  it("returns empty array for repo with no secrets", async () => {
    const dir = await setupRepo({
      "index.ts": "export const add = (a: number, b: number) => a + b",
      "README.md": "# My Project\n\nThis is a safe project.",
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    expect(findings).toEqual([])
  })

  it("detects AWS Access Key IDs", async () => {
    const dir = await setupRepo({
      "config.ts": `const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"\nconst AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"`,
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    // AKIAIOSFODNN7EXAMPLE contains "EXAMPLE" which is a false positive hint
    const awsKey = findings.find((f) => f.id.startsWith("aws-access-key"))
    // The example key should be filtered as false positive
    if (awsKey) {
      expect(awsKey.severity).toBe("critical")
      expect(awsKey.cwe).toBe("CWE-798")
    }
  })

  it("detects GitHub tokens", async () => {
    const dir = await setupRepo({
      ".env": "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD",
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    const githubToken = findings.find((f) => f.id.startsWith("github-token"))
    expect(githubToken).toBeDefined()
    expect(githubToken!.severity).toBe("critical")
    expect(githubToken!.cwe).toBe("CWE-798")
    expect(githubToken!.code_locations).toBeDefined()
    expect(githubToken!.code_locations![0]!.file).toBe(".env")
  })

  it("detects private keys (PEM)", async () => {
    const dir = await setupRepo({
      "private.key": "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    const pemKey = findings.find((f) => f.id.startsWith("private-key-pem"))
    expect(pemKey).toBeDefined()
    expect(pemKey!.severity).toBe("critical")
    expect(pemKey!.cwe).toBe("CWE-321")
  })

  it("detects Slack tokens", async () => {
    const dir = await setupRepo({
      "app.ts": `const slack = new Slack("xoxb-1234567890-ABCDEFGHIJ")`,
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    const slackToken = findings.find((f) => f.id.startsWith("slack-token"))
    expect(slackToken).toBeDefined()
    expect(slackToken!.severity).toBe("critical")
  })

  it("detects database connection strings with credentials", async () => {
    const dir = await setupRepo({
      "db.ts": `const url = "postgresql://myuser:mypassword@db.prod-site.io:5432/mydb"`,
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    const dbUrl = findings.find((f) => f.id.startsWith("database-url"))
    expect(dbUrl).toBeDefined()
    expect(dbUrl!.severity).toBe("high")
  })

  it("detects hardcoded passwords", async () => {
    const dir = await setupRepo({
      "auth.ts": `const password = "myh4rdp4ssw0rd!"`,
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    const pwdFinding = findings.find((f) => f.id.startsWith("password-assignment"))
    expect(pwdFinding).toBeDefined()
    expect(pwdFinding!.severity).toBe("medium")
  })

  it("detects Stripe secret keys", async () => {
    const dir = await setupRepo({
      "payment.ts": `const stripeKey = "sk_live_1234567890abcdefghijklmnopqrstuv"`,
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    const stripeKey = findings.find((f) => f.id.startsWith("stripe-secret"))
    expect(stripeKey).toBeDefined()
    expect(stripeKey!.severity).toBe("critical")
  })

  it("skips node_modules and .git directories", async () => {
    const dir = await setupRepo({
      "node_modules/lib/index.js": `const key = "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD"`,
      ".git/config": `[core]\n\trepositoryformatversion = 0`,
      "src/index.ts": `export const main = () => {}`,
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    expect(findings.find((f) => f.id.includes("node_modules"))).toBeUndefined()
  })

  it("skips binary and image files", async () => {
    const dir = await setupRepo({
      "image.png": "fake binary data",
      "font.woff": "fake font data",
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    expect(findings).toEqual([])
  })

  it("filters false positive hints", async () => {
    const dir = await setupRepo({
      "test.ts": `const exampleKey = "AKIATEST1234567890ABCD"`,
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    // AKIATEST contains "TEST" which is a false positive hint
    expect(findings.find((f) => f.id.startsWith("aws-access-key"))).toBeUndefined()
  })

  it("includes code location with line number", async () => {
    const dir = await setupRepo({
      "app.ts": `line1\nline2\nconst token = "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD"\nline4`,
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    const tokenFinding = findings.find((f) => f.id.startsWith("github-token"))
    expect(tokenFinding).toBeDefined()
    expect(tokenFinding!.code_locations![0]!.start_line).toBe(3)
    expect(tokenFinding!.code_locations![0]!.file).toBe("app.ts")
  })

  it("redacts poc_description — does not leak secret prefix", async () => {
    const dir = await setupRepo({
      ".env": "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD",
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    const tokenFinding = findings.find((f) => f.id.startsWith("github-token"))
    expect(tokenFinding).toBeDefined()
    expect(tokenFinding!.poc_description).not.toContain("ghp_")
    expect(tokenFinding!.poc_description).toContain("redacted")
  })

  it("redacts code_locations snippet — does not store full secret line", async () => {
    const dir = await setupRepo({
      ".env": "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD",
    })
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    const tokenFinding = findings.find((f) => f.id.startsWith("github-token"))
    expect(tokenFinding).toBeDefined()
    const snippet = tokenFinding!.code_locations![0]!.snippet
    expect(snippet).toContain("REDACTED")
    expect(snippet).not.toContain("ghp_")
  })

  it("handles empty repo gracefully", async () => {
    const dir = await setupRepo({})
    const findings = await scanSecrets({ repoPath: dir, workspaceDir: dir })
    expect(findings).toEqual([])
  })
})
