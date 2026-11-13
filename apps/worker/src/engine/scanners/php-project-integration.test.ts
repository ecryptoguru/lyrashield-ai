import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { scanIac } from "./iac-scanner"
import { scanSast } from "./sast-scanner"
import * as runtime from "./php-runtime"
import type { ScannerCoverageIssue } from "../scanner-coverage"

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function repo(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "php-project-"))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), content)
  }
  return dir
}

describe("PHP analysis uses existing repository discovery", () => {
  it.each(["STANDARD", "DEEP"])("analyzes detected PHP services in %s", async (mode) => {
    const dir = await repo({
      "services/api/Dockerfile": "FROM php:8.4.26-fpm\n",
      "services/api/public/RUN.PHP": "<?php system($_GET['cmd']);",
      "services/web/Dockerfile": "FROM node:24\n",
    })
    const coverageIssues: ScannerCoverageIssue[] = []
    const findings = (
      await Promise.all([
        scanSast({ repoPath: dir, workspaceDir: dir, mode, coverageIssues }),
        scanIac({ repoPath: dir, workspaceDir: dir, coverageIssues }),
      ])
    ).flat()
    expect(findings).toContainEqual(expect.objectContaining({ cve: "CVE-2026-109618" }))
    expect(findings).toContainEqual(
      expect.objectContaining({
        finding_class: "php_source_flow",
        target: "services/api/public/RUN.PHP",
      })
    )
    expect(
      findings
        .filter((finding) => finding.finding_class?.startsWith("php_"))
        .every((finding) => !finding.target?.startsWith("services/web/"))
    ).toBe(true)
  })

  it.each(["STANDARD", "DEEP"])(
    "isolates Windows package evidence to its PHP service in %s",
    async (mode) => {
      const dir = await repo({
        "services/api/php-runtime.json": JSON.stringify({
          schemaVersion: 1,
          version: "8.4.27",
          os: "windows",
          windowsPackage: { origin: "php.net", build: "8.4.27" },
        }),
        "services/api/index.php": "<?php echo 1;",
        "services/web/Dockerfile": "FROM node:24\n",
      })
      const coverageIssues: ScannerCoverageIssue[] = []
      const findings = (
        await Promise.all([
          scanSast({ repoPath: dir, workspaceDir: dir, mode, coverageIssues }),
          scanIac({ repoPath: dir, workspaceDir: dir, coverageIssues }),
        ])
      ).flat()
      const result = findings.filter((finding) => finding.cve === "CVE-2026-111497")
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        target: "services/api/php-runtime.json",
        finding_class: "php_runtime_windows_brotli",
      })
      expect(coverageIssues.some((issue) => /Brotli.*verify/i.test(issue.reason))).toBe(true)
    }
  )

  it("does not invoke PHP runtime analysis for non-PHP infrastructure or documentation mentions", async () => {
    const inspect = vi.spyOn(runtime, "inspectPhpRuntimeInput")
    const dir = await repo({
      Dockerfile: "FROM node:24\n# PHP migration reference\n",
      "compose.yml": "services:\n  cache:\n    image: redis:7\n",
      "project.toml": '[project]\nname="PHP documentation"\n',
      "docs/example.php": "<?php system($_GET['cmd']);",
      "fixtures/example.php": "<?php",
      "tests/ExampleTest.php": "<?php",
      "vendor/legacy.php": "<?php",
    })
    const coverageIssues: ScannerCoverageIssue[] = []
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir, coverageIssues })
    expect(inspect).not.toHaveBeenCalled()
    expect(findings.filter((finding) => finding.finding_class?.startsWith("php_"))).toEqual([])
    expect(coverageIssues.filter((issue) => /PHP/.test(issue.reason))).toEqual([])
    expect(
      (await scanSast({ repoPath: dir, workspaceDir: dir })).filter((finding) =>
        finding.finding_class?.startsWith("php_")
      )
    ).toEqual([])
  })

  it("does not let one service identity hide a sibling service's missing runtime identity", async () => {
    const dir = await repo({
      "a/Dockerfile": "FROM php:8.4.27-fpm\n",
      "b/index.php": "<?php",
    })
    const coverageIssues: ScannerCoverageIssue[] = []
    await scanIac({ repoPath: dir, workspaceDir: dir, coverageIssues })
    expect(coverageIssues).toContainEqual(
      expect.objectContaining({ status: "partial", reason: expect.stringMatching(/PHP.*identity/) })
    )
  })

  it("emits an informational configuration review without claiming a version fix", async () => {
    const dir = await repo({
      "php.ini": "session.upload_progress.enabled=1\nsession.serialize_handler=php_serialize\n",
    })
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir })
    const notice = findings.find((finding) => finding.cve === "CVE-2026-115560")
    expect(notice).toMatchObject({
      severity: "info",
      finding_class: "php_runtime_config",
      dependency_metadata: { runtime_verified: false, applicability: "configuration_review" },
    })
    expect(notice?.description).toMatch(/ini_set.*session_start/)
    expect(notice?.remediation_steps).toMatch(/startup.*restart/)
    expect(notice?.dependency_metadata).not.toHaveProperty("fixed_version")
    expect(notice?.code_locations?.[0]).not.toHaveProperty("fix_after")
  })
  it("does not turn a disabled upload-progress configuration into a notice candidate", async () => {
    const dir = await repo({
      "php.ini": "session.upload_progress.enabled=0\nsession.serialize_handler=php_serialize\n",
    })
    expect(
      (await scanIac({ repoPath: dir, workspaceDir: dir })).some(
        (finding) => finding.cve === "CVE-2026-115560"
      )
    ).toBe(false)
  })
})

it("does not inherit a root runtime identity across independently configured services", async () => {
  const dir = await repo({
    Dockerfile: "FROM php:8.4.27-fpm\n",
    "services/api/Dockerfile": "FROM acme/api:1.0\n",
    "services/api/public/index.php": "<?php echo 'hello';",
    "services/web/package.json": '{"name":"web"}',
  })
  const discovery: import("../scanner-coverage").ScannerDiscovery = {}
  await scanIac({ repoPath: dir, workspaceDir: dir, discovery })
  expect(discovery.iac?.php).toMatchObject({ incomplete: true })
  expect(discovery.iac?.php?.scopes).toContainEqual({
    directory: "services/api/public",
    hasExactRuntimeIdentity: false,
  })
  const { phpContextForFile } = await import("../php-engine-context")
  expect(phpContextForFile("services/web/agent.ts", discovery.iac?.php)).toBe("")
})
