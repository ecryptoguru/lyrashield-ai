/* eslint-disable security/detect-non-literal-fs-filename */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { rmSync } from "fs"

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { scanSca } from "./sca-scanner"

const TEST_DIR = join(tmpdir(), "lyrashield-sca-test-" + Date.now())

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

type OsvResponse = { vulns?: Array<Record<string, unknown>> }

function makeMockFetch(
  responses: Record<string, Array<Record<string, unknown>>>,
  calls?: Array<{ count: number }>
): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string)
    const queries = body.queries ?? [body]
    calls?.push({ count: queries.length })
    const results = queries.map((query: { package?: { name?: string }; version?: string }) => ({
      vulns: responses[`${query.package?.name}@${query.version}`] ?? [],
    }))
    const data = body.queries ? { results } : (results[0] as OsvResponse)
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
}

describe("scanSca", () => {
  beforeEach(() => {
    cleanupRepo()
  })

  it("returns empty array when no dependency files exist", async () => {
    const dir = await setupRepo({ "README.md": "# test" })
    const findings = await scanSca({ repoPath: dir, workspaceDir: dir })
    expect(findings).toEqual([])
    cleanupRepo()
  })

  it("parses package.json dependencies", async () => {
    const dir = await setupRepo({
      "package.json": JSON.stringify({
        name: "test-pkg",
        dependencies: { lodash: "4.17.20", express: "4.18.0" },
        devDependencies: { jest: "29.0.0" },
      }),
    })

    const fetchFn = makeMockFetch({
      "lodash@4.17.20": [
        {
          id: "GHSA-1234",
          summary: "Prototype pollution in lodash",
          database_specific: { severity: "high" },
          affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }],
        },
      ],
    })

    try {
      const findings = await scanSca({ repoPath: dir, workspaceDir: dir, fetchFn })
      expect(findings.length).toBeGreaterThanOrEqual(1)
      const lodashFinding = findings.find((f) => f.title.includes("lodash"))
      expect(lodashFinding).toBeDefined()
      expect(lodashFinding!.severity).toBe("high")
      expect(lodashFinding!.cwe).toBe("CWE-1104")
      expect(lodashFinding!.remediation_steps).toContain("4.17.21")
    } finally {
      cleanupRepo()
    }
  })

  it("discovers dependency manifests in nested workspaces", async () => {
    const dir = await setupRepo({
      "apps/api/package.json": JSON.stringify({ dependencies: { "nested-pkg": "1.2.3" } }),
    })
    const fetchFn = makeMockFetch({
      "nested-pkg@1.2.3": [{ id: "GHSA-nested", summary: "Nested dependency issue" }],
    })

    try {
      const findings = await scanSca({ repoPath: dir, workspaceDir: dir, fetchFn })
      expect(findings.some((finding) => finding.title.includes("nested-pkg"))).toBe(true)
    } finally {
      cleanupRepo()
    }
  })

  it("parses requirements.txt dependencies", async () => {
    const dir = await setupRepo({
      "requirements.txt": "requests==2.25.0\nflask>=1.1.0\nnumpy==1.19.0\n",
    })

    const fetchFn = makeMockFetch({
      "requests@2.25.0": [
        {
          id: "PYSEC-1234",
          summary: "SSRF in requests library",
          database_specific: { severity: "high" },
        },
      ],
    })

    try {
      const findings = await scanSca({ repoPath: dir, workspaceDir: dir, fetchFn })
      const requestsFinding = findings.find((f) => f.title.includes("requests"))
      expect(requestsFinding).toBeDefined()
      expect(requestsFinding!.severity).toBe("high")
    } finally {
      cleanupRepo()
    }
  })

  it("parses Maven pom.xml dependencies", async () => {
    const dir = await setupRepo({
      "pom.xml": `
        <project><dependencies><dependency>
          <groupId>org.example</groupId><artifactId>unsafe-lib</artifactId><version>1.2.3</version>
        </dependency></dependencies></project>`,
    })
    const fetchFn = makeMockFetch({
      "org.example:unsafe-lib@1.2.3": [{ id: "GHSA-maven", summary: "Maven issue" }],
    })

    try {
      const findings = await scanSca({ repoPath: dir, workspaceDir: dir, fetchFn })
      expect(findings.some((finding) => finding.title.includes("org.example:unsafe-lib"))).toBe(
        true
      )
    } finally {
      cleanupRepo()
    }
  })

  it("parses Gradle dependencies", async () => {
    const dir = await setupRepo({
      "build.gradle": `dependencies {\n  implementation 'org.example:unsafe-lib:2.0.0'\n}`,
    })
    const fetchFn = makeMockFetch({
      "org.example:unsafe-lib@2.0.0": [{ id: "GHSA-gradle", summary: "Gradle issue" }],
    })

    try {
      const findings = await scanSca({ repoPath: dir, workspaceDir: dir, fetchFn })
      expect(findings.some((finding) => finding.title.includes("org.example:unsafe-lib"))).toBe(
        true
      )
    } finally {
      cleanupRepo()
    }
  })

  it("handles OSV API failures gracefully", async () => {
    const dir = await setupRepo({
      "package.json": JSON.stringify({ dependencies: { lodash: "4.17.20" } }),
    })

    const fetchFn = (async () => {
      throw new Error("Network error")
    }) as typeof fetch

    try {
      const findings = await scanSca({ repoPath: dir, workspaceDir: dir, fetchFn })
      expect(findings).toEqual([])
    } finally {
      cleanupRepo()
    }
  })

  it("deduplicates vulnerabilities by ID", async () => {
    const dir = await setupRepo({
      "package.json": JSON.stringify({ dependencies: { "pkg-a": "1.0.0", "pkg-b": "2.0.0" } }),
    })

    const fetchFn = makeMockFetch({
      "pkg-a@1.0.0": [
        {
          id: "SHARED-VULN-001",
          summary: "Shared vulnerability",
          database_specific: { severity: "medium" },
        },
      ],
      "pkg-b@2.0.0": [
        {
          id: "SHARED-VULN-001",
          summary: "Shared vulnerability",
          database_specific: { severity: "medium" },
        },
      ],
    })

    try {
      const findings = await scanSca({ repoPath: dir, workspaceDir: dir, fetchFn })
      expect(findings.length).toBe(1)
      expect(findings[0]!.id).toBe("SHARED-VULN-001")
    } finally {
      cleanupRepo()
    }
  })

  it("deduplicates dependencies before a single OSV batch request", async () => {
    const dir = await setupRepo({
      "package.json": JSON.stringify({ dependencies: { lodash: "4.17.20" } }),
      "nested/package.json": JSON.stringify({ dependencies: { lodash: "4.17.20" } }),
    })
    const calls: Array<{ count: number }> = []
    try {
      await scanSca({ repoPath: dir, workspaceDir: dir, fetchFn: makeMockFetch({}, calls) })
      expect(calls).toEqual([{ count: 1 }])
    } finally {
      cleanupRepo()
    }
  })

  it("splits OSV queries into batches of at most 100 dependencies", async () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`pkg-${index}`, "1.0.0"])
    )
    const dir = await setupRepo({ "package.json": JSON.stringify({ dependencies }) })
    const calls: Array<{ count: number }> = []
    try {
      await scanSca({ repoPath: dir, workspaceDir: dir, fetchFn: makeMockFetch({}, calls) })
      expect(calls.map((call) => call.count)).toEqual([100, 1])
    } finally {
      cleanupRepo()
    }
  })
})
