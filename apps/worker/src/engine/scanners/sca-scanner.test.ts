import { describe, it, expect, vi, beforeEach } from "vitest"
import { writeFile, mkdir, symlink, chmod } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { rmSync } from "fs"
import { performance } from "node:perf_hooks"

// The shared OSV client uses an isolated in-memory cache here, never a database.
vi.mock("../../../../../packages/db/src/client", () => ({ prisma: {} }))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { scanSca } from "./sca-scanner"
import { resolveExactDependencies } from "./resolved-dependencies"
import { composerContentHash } from "./composer-dependencies"
import { generateDedupeKey } from "../output-parser"
import { queryOsvWithCache } from "../../../../../packages/db/src/osv-client"
import { InMemoryAdvisoryCache } from "../../../../../packages/db/src/advisory-cache-service"
import { clearThreatIntelligenceCache } from "./threat-intelligence"
import type { ScannerCoverageIssue } from "../scanner-coverage"

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
    clearThreatIntelligenceCache()
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
      expect(lodashFinding).toMatchObject({
        finding_class: "dependency_cve",
        dependency_metadata: {
          package_name: "lodash",
          installed_version: "4.17.20",
          package_ecosystem: "npm",
          fixed_version: "4.17.21",
        },
      })
    } finally {
      cleanupRepo()
    }
  })

  it("uses the proxy fetch only for CISA while OSV and FIRST stay direct", async () => {
    const dir = await setupRepo({
      "package.json": JSON.stringify({ dependencies: { lodash: "4.17.20" } }),
    })
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("api.osv.dev")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                vulns: [
                  {
                    id: "CVE-2024-12345",
                    summary: "Dependency issue",
                    database_specific: { severity: "high" },
                  },
                ],
              },
            ],
          })
        )
      }
      if (url.includes("api.first.org")) {
        return new Response(JSON.stringify({ data: [{ cve: "CVE-2024-12345", epss: "0.5" }] }))
      }
      throw new Error(`Unexpected direct fetch: ${url} ${init?.method ?? "GET"}`)
    }) as unknown as typeof fetch
    const cisaFetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ vulnerabilities: [{ cveID: "CVE-2024-12345" }] }), {
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch

    try {
      const findings = await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        fetchFn,
        cisaFetchFn,
        cisaResolver: async () => ["93.184.216.34"],
      })

      expect(findings[0]?.technical_analysis).toContain("CISA KEV")
      expect(findings[0]?.technical_analysis).toContain("FIRST EPSS")
      expect(cisaFetchFn).toHaveBeenCalledTimes(1)
      expect(String(vi.mocked(cisaFetchFn).mock.calls[0]?.[0])).toContain("www.cisa.gov")
      expect(vi.mocked(fetchFn).mock.calls.map((call) => String(call[0]))).toEqual([
        "https://api.osv.dev/v1/querybatch",
        "https://api.osv.dev/v1/vulns/CVE-2024-12345",
        expect.stringContaining("https://api.first.org/data/v1/epss?"),
      ])
      expect(vi.mocked(fetchFn).mock.calls[0]?.[1]?.method).toBe("POST")
      expect(
        vi.mocked(fetchFn).mock.calls.some((call) => String(call[0]).includes("cisa.gov"))
      ).toBe(false)
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

  it("resolves local Maven properties and records unresolved managed versions as partial coverage", async () => {
    const dir = await setupRepo({
      "pom.xml": [
        "<project>",
        "  <properties><unsafe.version>2.0.0</unsafe.version></properties>",
        "  <dependencies>",
        "    <dependency><groupId>org.example</groupId><artifactId>unsafe-lib</artifactId><version>${unsafe.version}</version></dependency>",
        "    <dependency><groupId>org.example</groupId><artifactId>managed-only</artifactId></dependency>",
        "  </dependencies>",
        "</project>",
      ].join("\n"),
    })
    const coverageIssues: ScannerCoverageIssue[] = []
    const fetchFn = makeMockFetch({
      "org.example:unsafe-lib@2.0.0": [{ id: "GHSA-property", summary: "Property version issue" }],
    })

    try {
      const findings = await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        fetchFn,
        coverageIssues,
      })
      expect(findings.some((finding) => finding.id === "GHSA-property")).toBe(true)
      expect(coverageIssues).toContainEqual(
        expect.objectContaining({
          scanner: "sca",
          status: "partial",
          subject: "pom.xml",
        })
      )
    } finally {
      cleanupRepo()
    }
  })

  it("resolves locally managed Maven dependency versions", async () => {
    const dir = await setupRepo({
      "pom.xml": [
        "<project>",
        "  <dependencyManagement><dependencies>",
        "    <dependency><groupId>org.example</groupId><artifactId>unsafe-lib</artifactId><version>2.0.0</version></dependency>",
        "  </dependencies></dependencyManagement>",
        "  <dependencies>",
        "    <dependency><groupId>org.example</groupId><artifactId>unsafe-lib</artifactId></dependency>",
        "  </dependencies>",
        "</project>",
      ].join("\n"),
    })
    try {
      const findings = await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        fetchFn: makeMockFetch({
          "org.example:unsafe-lib@2.0.0": [
            { id: "GHSA-managed", summary: "Managed version issue" },
          ],
        }),
      })
      expect(findings.some((finding) => finding.id === "GHSA-managed")).toBe(true)
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

  const gradleFixtures: Array<{ name: string; files: Record<string, string> }> = [
    {
      name: "interpolated version",
      files: {
        "build.gradle": [
          'def unsafeVersion = "2.0.0"',
          "dependencies {",
          '  implementation "org.example:unsafe-lib:$unsafeVersion"',
          "}",
        ].join("\n"),
      },
    },
    {
      name: "map notation",
      files: {
        "build.gradle": [
          "dependencies {",
          '  implementation group: "org.example", name: "unsafe-lib", version: "2.0.0"',
          "}",
        ].join("\n"),
      },
    },
    {
      name: "version catalog",
      files: {
        "build.gradle": ["dependencies {", "  implementation(libs.unsafe.lib)", "}"].join("\n"),
        "gradle/libs.versions.toml": [
          "[versions]",
          'unsafe = "2.0.0"',
          "",
          "[libraries]",
          'unsafe-lib = { module = "org.example:unsafe-lib", version.ref = "unsafe" }',
        ].join("\n"),
      },
    },
  ]

  it.each(gradleFixtures)("parses Gradle $name dependencies", async ({ files }) => {
    const dir = await setupRepo(files)
    try {
      const findings = await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        fetchFn: makeMockFetch({
          "org.example:unsafe-lib@2.0.0": [
            { id: "GHSA-gradle-indirection", summary: "Gradle issue" },
          ],
        }),
      })
      expect(findings.some((finding) => finding.id === "GHSA-gradle-indirection")).toBe(true)
    } finally {
      cleanupRepo()
    }
  })

  it("bounds oversized malformed POM input and records incomplete coverage", async () => {
    const dir = await setupRepo({ "pom.xml": "<dependency>".repeat(50_000) })
    const coverageIssues: ScannerCoverageIssue[] = []
    try {
      await expect(
        scanSca({
          repoPath: dir,
          workspaceDir: dir,
          fetchFn: makeMockFetch({}),
          coverageIssues,
        })
      ).resolves.toEqual([])
      expect(coverageIssues).toContainEqual(
        expect.objectContaining({ scanner: "sca", status: "bounded", subject: "pom.xml" })
      )
    } finally {
      cleanupRepo()
    }
  })

  it("handles malformed POM dependency markers in bounded time", async () => {
    const dir = await setupRepo({ "pom.xml": "<dependency>".repeat(40_000) })
    const coverageIssues: ScannerCoverageIssue[] = []
    const startedAt = performance.now()
    try {
      await expect(
        scanSca({
          repoPath: dir,
          workspaceDir: dir,
          fetchFn: makeMockFetch({}),
          coverageIssues,
        })
      ).resolves.toEqual([])
      expect(performance.now() - startedAt).toBeLessThan(1_000)
      expect(coverageIssues).toContainEqual(
        expect.objectContaining({ scanner: "sca", status: "partial", subject: "pom.xml" })
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

  it("keeps the same vulnerability ID distinct across packages", async () => {
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
      expect(findings).toHaveLength(2)
      expect(findings.map((finding) => finding.dependency_metadata?.package_name).sort()).toEqual([
        "pkg-a",
        "pkg-b",
      ])
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

// Keep real repository parsing and scanner behavior; only advisory transport is fake.
describe("Composer SCA", () => {
  it("keeps identical vulnerable releases actionable in each Composer service", async () => {
    const manifest = { require: { "vendor/pkg": "^1.0" } }
    const lock = {
      "content-hash": composerContentHash(manifest),
      packages: [{ name: "vendor/pkg", version: "1.2.3" }],
    }
    const dir = await setupRepo(
      Object.fromEntries(
        ["services/One", "services/Two"].flatMap((service) => [
          [`${service}/composer.json`, JSON.stringify(manifest)],
          [`${service}/composer.lock`, JSON.stringify(lock)],
        ])
      )
    )
    try {
      const inventory = await resolveExactDependencies({ repoPath: dir })
      expect(inventory.status).toBe("COMPLETE")
      expect(inventory.packages.map((pkg) => pkg.filePath).sort()).toEqual([
        "services/One/composer.lock",
        "services/Two/composer.lock",
      ])
      const advisory = {
        id: "GHSA-shared",
        affected: [
          {
            package: { name: "vendor/pkg", ecosystem: "Packagist" },
            ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.2.4" }] }],
          },
        ],
      }
      const calls: Array<{ count: number }> = []
      const findings = await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        fetchFn: makeMockFetch({ "vendor/pkg@1.2.3": [advisory] }, calls),
      })
      expect(calls).toEqual([{ count: 1 }])
      expect(findings).toHaveLength(2)
      expect(findings.map((finding) => finding.dependency_metadata?.lockfile_path).sort()).toEqual([
        "services/One/composer.lock",
        "services/Two/composer.lock",
      ])
      expect(
        findings.every((finding) => finding.dependency_metadata?.fixed_version === "1.2.4")
      ).toBe(true)
      expect(new Set(findings.map((finding) => generateDedupeKey(finding, "target-1"))).size).toBe(
        2
      )
      expect(
        generateDedupeKey(
          {
            ...findings[0]!,
            dependency_metadata: {
              ...findings[0]!.dependency_metadata,
              lockfile_path: "services/WEB/composer.lock",
            },
          },
          "target-1"
        )
      ).not.toBe(
        generateDedupeKey(
          {
            ...findings[0]!,
            dependency_metadata: {
              ...findings[0]!.dependency_metadata,
              lockfile_path: "services/web/composer.lock",
            },
          },
          "target-1"
        )
      )
      // The shared advisory cache deduplicates network queries, but each lock remains a finding.
      const sharedCalls: Array<{ count: number }> = []
      const advisoryBatch = await queryOsvWithCache(inventory.packages, {
        cache: new InMemoryAdvisoryCache(),
        fetchFn: makeMockFetch({ "vendor/pkg@1.2.3": [advisory] }, sharedCalls),
      })
      expect(sharedCalls).toEqual([{ count: 1 }])
      expect(advisoryBatch.status).toBe("COMPLETE")
      const shared = await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        resolvedDependencyInventory: inventory,
        advisoryBatch,
      })
      expect(shared.map((finding) => generateDedupeKey(finding, "target-1")).sort()).toEqual(
        findings.map((finding) => generateDedupeKey(finding, "target-1")).sort()
      )
    } finally {
      cleanupRepo()
    }
  })

  beforeEach(() => {
    cleanupRepo()
    clearThreatIntelligenceCache()
  })

  it("queries the locked release, including transitive dependencies, rather than stripped ranges", async () => {
    const dir = await setupRepo({
      "composer.json": JSON.stringify({
        require: { "vendor/pkg": "^1.0", php: "^8.3", "ext-json": "*" },
      }),
      "composer.lock": JSON.stringify({
        "content-hash": "ae249e840ca7ae6b6c5fa888a15191cb",
        packages: [
          { name: "vendor/pkg", version: "1.2.3" },
          { name: "vendor/transitive", version: "2.0.1" },
        ],
      }),
    })
    try {
      const findings = await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        fetchFn: makeMockFetch({
          "vendor/pkg@1.2.3": [{ id: "GHSA-locked", summary: "Locked issue" }],
          "vendor/transitive@2.0.1": [{ id: "GHSA-transitive", summary: "Transitive issue" }],
          "vendor/pkg@1.0": [{ id: "GHSA-guessed" }],
        }),
      })
      expect(findings.map((finding) => finding.id)).toEqual(["GHSA-locked", "GHSA-transitive"])
      expect(findings[0]).toMatchObject({
        target: "composer.lock",
        dependency_metadata: {
          installed_version: "1.2.3",
          package_ecosystem: "packagist",
          lockfile_path: "composer.lock",
        },
        code_locations: [
          { file: "composer.lock", label: expect.stringContaining("Resolved Composer package") },
        ],
      })
    } finally {
      cleanupRepo()
    }
  })

  it("keeps missing Composer lock coverage incomplete without querying a guessed release", async () => {
    const dir = await setupRepo({
      "composer.json": JSON.stringify({ require: { "vendor/pkg": "^1.0" } }),
    })
    const coverageIssues: ScannerCoverageIssue[] = []
    try {
      const findings = await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        coverageIssues,
        fetchFn: makeMockFetch({ "vendor/pkg@1.0": [{ id: "GHSA-guessed" }] }),
      })
      expect(findings).toEqual([])
      expect(coverageIssues).toContainEqual(expect.objectContaining({ scanner: "sca" }))
    } finally {
      cleanupRepo()
    }
  })

  it.each([new Response("down", { status: 503 }), new Response(JSON.stringify({ results: [] }))])(
    "records advisory transport and truncated response failures as incomplete coverage",
    async (response) => {
      const dir = await setupRepo({
        "package.json": JSON.stringify({ dependencies: { lodash: "4.17.20" } }),
      })
      const coverageIssues: ScannerCoverageIssue[] = []
      try {
        await scanSca({
          repoPath: dir,
          workspaceDir: dir,
          coverageIssues,
          fetchFn: async () => response,
        })
        expect(coverageIssues).toContainEqual(
          expect.objectContaining({ scanner: "sca", status: "partial" })
        )
      } finally {
        cleanupRepo()
      }
    }
  )

  it("records empty standalone input as unsupported coverage", async () => {
    const dir = await setupRepo({ "README.md": "empty" })
    const coverageIssues: ScannerCoverageIssue[] = []
    try {
      await scanSca({ repoPath: dir, workspaceDir: dir, coverageIssues })
      expect(coverageIssues).toContainEqual(
        expect.objectContaining({ scanner: "sca", status: "unsupported" })
      )
    } finally {
      cleanupRepo()
    }
  })
})

describe("SCA advisory coverage", () => {
  beforeEach(() => {
    cleanupRepo()
    clearThreatIntelligenceCache()
  })

  it.each([[], { vulns: [null] }, { vulns: [{ summary: "missing advisory id" }] }])(
    "rejects malformed advisory records without reporting clean coverage",
    async (entry) => {
      const dir = await setupRepo({
        "package.json": JSON.stringify({ dependencies: { lodash: "4.17.20" } }),
      })
      const coverageIssues: ScannerCoverageIssue[] = []
      try {
        const findings = await scanSca({
          repoPath: dir,
          workspaceDir: dir,
          coverageIssues,
          fetchFn: async () => new Response(JSON.stringify({ results: [entry] })),
        })
        expect(findings).toEqual([])
        expect(coverageIssues).toContainEqual(
          expect.objectContaining({ scanner: "sca", status: "partial" })
        )
      } finally {
        cleanupRepo()
      }
    }
  )

  it("retains advisory findings while marking a shared partial batch incomplete", async () => {
    const dir = await setupRepo({})
    const coverageIssues: ScannerCoverageIssue[] = []
    const pkg = {
      name: "vendor/pkg",
      version: "1.2.3",
      ecosystem: "Packagist" as const,
      filePath: "composer.lock",
    }
    try {
      const findings = await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        coverageIssues,
        resolvedDependencyInventory: {
          status: "PARTIAL",
          packages: [pkg],
          unresolved: [{ ecosystem: "Packagist", name: "vendor/missing", reason: "not resolved" }],
          truncated: false,
          evidenceFile: {
            path: "composer.lock",
            content: "{}",
            size: 2,
            extension: ".lock",
            language: "json",
          },
        },
        advisoryBatch: {
          status: "PARTIAL",
          source: "OSV",
          requestedCount: 2,
          resolvedCount: 1,
          results: [
            { package: pkg, vulns: [{ id: "GHSA-exact", summary: "Exact lock advisory" }] },
          ],
          fetchedAt: null,
          snapshotId: null,
          snapshotChecksum: null,
          cacheAgeSeconds: null,
          supportedEcosystems: ["Packagist"],
          unresolved: [
            { ecosystem: "Packagist", name: "vendor/missing", reason: "advisory unavailable" },
          ],
        },
      })
      expect(findings.map((finding) => finding.id)).toEqual(["GHSA-exact"])
      expect(coverageIssues).toContainEqual(
        expect.objectContaining({ scanner: "sca", status: "partial" })
      )
    } finally {
      cleanupRepo()
    }
  })

  it("records missing shared advisory batches and unsupported inventories", async () => {
    const dir = await setupRepo({})
    const coverageIssues: ScannerCoverageIssue[] = []
    try {
      const findings = await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        coverageIssues,
        resolvedDependencyInventory: {
          status: "UNSUPPORTED",
          packages: [],
          unresolved: [],
          truncated: false,
          evidenceFile: {
            path: "dependency-lockfile",
            content: "",
            size: 0,
            extension: ".json",
            language: "json",
          },
        },
      })
      expect(findings).toEqual([])
      expect(coverageIssues).toContainEqual(
        expect.objectContaining({ scanner: "sca", status: "unsupported" })
      )
    } finally {
      cleanupRepo()
    }
  })
})

describe("SCA review regressions", () => {
  beforeEach(() => {
    cleanupRepo()
    clearThreatIntelligenceCache()
  })

  it("validates COMPLETE shared advisory data before consuming findings", async () => {
    const dir = await setupRepo({})
    const coverageIssues: ScannerCoverageIssue[] = []
    const pkg = {
      name: "vendor/pkg",
      version: "1.2.3",
      ecosystem: "Packagist" as const,
      filePath: "composer.lock",
    }
    const other = { ...pkg, name: "vendor/other" }
    try {
      const findings = await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        coverageIssues,
        resolvedDependencyInventory: {
          status: "COMPLETE",
          packages: [pkg, other],
          unresolved: [],
          truncated: false,
          evidenceFile: {
            path: "composer.lock",
            content: "{}",
            size: 2,
            extension: ".lock",
            language: "json",
          },
        },
        advisoryBatch: {
          status: "COMPLETE",
          source: "OSV",
          requestedCount: 2,
          resolvedCount: 2,
          results: [
            { package: pkg, vulns: [null, { id: "GHSA-same-package" }] as never },
            { package: other, vulns: [{ id: "GHSA-retained" }] },
          ],
          fetchedAt: null,
          snapshotId: null,
          snapshotChecksum: null,
          cacheAgeSeconds: null,
          supportedEcosystems: ["Packagist"],
          unresolved: [],
        },
      })
      expect(findings.map((finding) => finding.id)).toEqual(["GHSA-same-package", "GHSA-retained"])
      expect(coverageIssues).toContainEqual(
        expect.objectContaining({ scanner: "sca", status: "partial" })
      )
    } finally {
      cleanupRepo()
    }
  })

  it("records skipped Composer symlinks in standalone mixed repository coverage", async () => {
    const dir = await setupRepo({
      "package.json": JSON.stringify({ dependencies: { lodash: "4.17.21" } }),
    })
    const externalManifest = TEST_DIR + "-composer.json"
    const externalLock = TEST_DIR + "-composer.lock"
    const coverageIssues: ScannerCoverageIssue[] = []
    await writeFile(externalManifest, JSON.stringify({ require: { "vendor/pkg": "^1" } }))
    await writeFile(
      externalLock,
      JSON.stringify({ packages: [{ name: "vendor/pkg", version: "1.2.3" }] })
    )
    await symlink(externalManifest, join(dir, "composer.json"))
    await symlink(externalLock, join(dir, "composer.lock"))
    try {
      const findings = await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        coverageIssues,
        fetchFn: makeMockFetch({ "vendor/pkg@1.2.3": [{ id: "GHSA-external" }] }),
      })
      expect(findings).toEqual([])
      expect(coverageIssues).toContainEqual(
        expect.objectContaining({
          scanner: "sca",
          status: "partial",
          reason: expect.stringContaining("symbolic link"),
        })
      )
    } finally {
      cleanupRepo()
      rmSync(externalManifest, { force: true })
      rmSync(externalLock, { force: true })
    }
  })
})

it.skipIf(process.getuid?.() === 0)(
  "records unreadable standalone dependency directories beside valid npm input",
  async () => {
    cleanupRepo()
    const dir = await setupRepo({
      "package.json": JSON.stringify({ dependencies: { lodash: "4.17.21" } }),
      "private/composer.json": "{}",
    })
    const privateDirectory = join(dir, "private")
    const coverageIssues: ScannerCoverageIssue[] = []
    await chmod(privateDirectory, 0)
    try {
      await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        coverageIssues,
        fetchFn: makeMockFetch({}),
      })
      expect(coverageIssues).toContainEqual(
        expect.objectContaining({
          scanner: "sca",
          status: "partial",
          reason: expect.stringContaining("directory could not be read"),
        })
      )
    } finally {
      await chmod(privateDirectory, 0o700)
      cleanupRepo()
    }
  }
)

it.each([
  ["13.28.0", "13.29.0"],
  ["14.0.0", undefined],
])("selects only a matching Composer advisory fix interval for %s", async (version, fixed) => {
  cleanupRepo()
  const dir = await setupRepo({
    "composer.lock": JSON.stringify({
      packages: [{ name: "vendor/pkg", version }],
      "packages-dev": [],
    }),
  })
  try {
    const findings = await scanSca({
      repoPath: dir,
      workspaceDir: dir,
      fetchFn: makeMockFetch({
        [`vendor/pkg@${version}`]: [
          {
            id: "GHSA-multi-branch",
            affected: [
              {
                package: { name: "vendor/other", ecosystem: "Packagist" },
                ranges: [
                  { type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "13.28.1" }] },
                ],
              },
              {
                package: { name: "vendor/pkg", ecosystem: "Packagist" },
                ranges: [
                  {
                    type: "ECOSYSTEM",
                    events: [
                      { introduced: "0" },
                      { fixed: "12.68.0" },
                      { introduced: "13.0.0" },
                      { fixed: "13.29.0" },
                      { introduced: "15.0.0" },
                      { fixed: "15.1.0" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    })
    expect(findings[0]?.dependency_metadata?.fixed_version).toBe(fixed)
  } finally {
    cleanupRepo()
  }
})

it.each([
  ["6.4", "6.4.32", "6.4.33"],
  ["6", "6.4.32", "6.4.33"],
  ["6.4", "6.3.99", undefined],
  ["6.4", "6.4.33", undefined],
  ["6.4.*", "6.4.32", undefined],
  ["6.4-beta", "6.4.32", undefined],
])(
  "handles Composer advisory introduction %s at installed %s",
  async (introduced, version, fixed) => {
    cleanupRepo()
    const dir = await setupRepo({
      "composer.lock": JSON.stringify({
        packages: [{ name: "symfony/process", version }],
        "packages-dev": [],
      }),
    })
    try {
      const findings = await scanSca({
        repoPath: dir,
        workspaceDir: dir,
        fetchFn: makeMockFetch({
          [`symfony/process@${version}`]: [
            {
              id: "GHSA-r39x-jcww-82v6",
              affected: [
                {
                  package: { name: "symfony/process", ecosystem: "Packagist" },
                  ranges: [{ type: "ECOSYSTEM", events: [{ introduced }, { fixed: "6.4.33" }] }],
                },
              ],
            },
          ],
        }),
      })
      expect(findings[0]?.dependency_metadata?.fixed_version).toBe(fixed)
    } finally {
      cleanupRepo()
    }
  }
)
