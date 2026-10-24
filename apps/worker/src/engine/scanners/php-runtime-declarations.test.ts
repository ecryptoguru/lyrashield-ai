import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { scanIac } from "./iac-scanner"
import { inspectPhpRuntimeInput } from "./php-runtime"
import type { ScannerCoverageIssue } from "../scanner-coverage"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function scan(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "php-declarations-"))
  directories.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const issues: ScannerCoverageIssue[] = []
  const findings = await scanIac({ repoPath: root, workspaceDir: root, coverageIssues: issues })
  return {
    root,
    issues,
    findings: findings.filter((finding) => finding.finding_class?.startsWith("php_runtime_")),
  }
}
const modern = (value: string) =>
  `[_]\nschema-version = "0.2"\n[[io.buildpacks.build.env]]\nname = "BP_PHP_VERSION"\nvalue = ${value}\n`
const legacy = (value: string) => `[[build.env]]\nname = "BP_PHP_VERSION"\nvalue = ${value}\n`

describe("PHP buildpack and version-file declarations", () => {
  it.each([
    [".php-version", "8.4.26\n"],
    ["project.toml", modern('"8.4.26"')],
    ["project.toml", legacy('"8.4.26"')],
    [
      "project.toml",
      modern('"8.4.26"') +
        '[[io.buildpacks.group]]\nid = "paketo-buildpacks/php"\nversion = "1.0"\n',
    ],
  ])(
    "discovers %s as unverified source evidence using the existing CVE catalog",
    async (path, content) => {
      const { findings, issues } = await scan({ [path!]: content! })
      expect(findings).toContainEqual(
        expect.objectContaining({
          cve: "CVE-2026-109618",
          scannerSource: "iac",
          dependency_metadata: expect.objectContaining({
            runtime_version: "8.4.26",
            evidence_scope: "source_declaration",
            runtime_verified: false,
          }),
        })
      )
      expect(
        findings.every((finding) =>
          finding.code_locations?.every((location) => !location.fix_after && !location.fix_before)
        )
      ).toBe(true)
      expect(issues).toContainEqual(
        expect.objectContaining({
          scanner: "iac",
          status: "partial",
          reason: expect.stringMatching(/override|unverified/i),
        })
      )
    }
  )

  it.each([
    "8.4",
    "^8.4.26",
    "8.4.26\n8.5.11",
    "8.4.26 # comment",
    "8.4.26\n# comment",
    "8.4.26-dev",
    "8.4.26\n\n",
    "",
  ])("rejects ambiguous .php-version %j without a CVE guess", async (content) => {
    const { findings, issues } = await scan({ ".php-version": content })
    expect(findings).toEqual([])
    expect(issues).toContainEqual(expect.objectContaining({ scanner: "iac", status: "partial" }))
  })

  it.each(['"8.4"', '"^8.4.26"', '"${PHP_VERSION}"', '""', "8.426", "true"])(
    "rejects an unresolved buildpack version %s",
    async (value) => {
      const { findings, issues } = await scan({ "project.toml": modern(value) })
      expect(findings).toEqual([])
      expect(issues).toContainEqual(expect.objectContaining({ scanner: "iac", status: "partial" }))
    }
  )

  it.each([
    modern('"8.4.26"') + 'value = "8.4.27"\n',
    modern('"8.4.26"') + '[[io.buildpacks.build.env]]\nname = "BP_PHP_VERSION"\nvalue = "8.4.27"\n',
    modern('"8.4.26"') + legacy('"8.4.27"'),
    modern('"8.4.26"').replace('"0.2"', '"0.3"'),
    modern('"8.4.26"') + "override = true\n",
    modern('"8.4.26"') + '[[io.buildpacks.group]]\nid = "vendor/custom-php"\nversion = "1.0"\n',
    modern('"8.4.26"') +
      '[[io.buildpacks.group]]\nid = "paketo-buildpacks/nodejs"\nversion = "1.0"\n',
    'schema-version = "0.3"\n' + legacy('"8.4.26"'),
    modern('"8.4.26"') + "[io.buildpacks]\ninclude = []\nexclude = []\n",
    modern('"8.4.26"') +
      '[[io.buildpacks.build.buildpacks]]\nid = "paketo-buildpacks/php"\nversion = "1.0"\n',
    'BP_PHP_VERSION = "8.4.26"\n',
    '[[io.buildpacks.build.env]\nname = "BP_PHP_VERSION"\n',
  ])(
    "keeps malformed, conflicting, overridden or unsupported project configuration incomplete",
    async (content) => {
      const { findings, issues } = await scan({ "project.toml": content })
      expect(findings).toEqual([])
      expect(issues).toContainEqual(expect.objectContaining({ scanner: "iac", status: "partial" }))
    }
  )

  it.each(["paketo-buildpacks/php", "paketo-buildpacks/php-dist"])(
    "keeps known PHP buildpack %s without an exact version partial",
    async (id) => {
      const { findings, issues } = await scan({
        "project.toml": `[_]\nschema-version = "0.2"\n[[io.buildpacks.group]]\nid = "${id}"\nversion = "1.0"\n`,
      })
      expect(findings).toEqual([])
      expect(issues).toContainEqual(expect.objectContaining({ scanner: "iac", status: "partial" }))
    }
  )

  it("does not infer PHP from non-PHP project configuration or comments", async () => {
    const { findings, issues } = await scan({
      "project.toml":
        '[_]\nschema-version = "0.2"\n# BP_PHP_VERSION = "8.4.26"\n[_.metadata]\ndescription = "BP_PHP_VERSION"\n[[io.buildpacks.build.env]]\nname = "BP_NODE_VERSION"\nvalue = "24.0.0"\n',
    })
    expect(findings).toEqual([])
    expect(issues).toEqual([])
  })

  it("ignores PHP-like project identifiers and freeform metadata in a Node descriptor", async () => {
    const { findings, issues } = await scan({
      "project.toml":
        '[_]\nschema-version = "0.2"\nid = "example/php-docs"\n[_.metadata.example]\nname = "BP_PHP_VERSION"\nvalue = "documentation example"\n[[io.buildpacks.build.env]]\nname = "BP_NODE_VERSION"\nvalue = "24.0.0"\n',
    })
    expect(findings).toEqual([])
    expect(issues).toEqual([])
  })

  it("does not count freeform metadata as a duplicate PHP environment declaration", async () => {
    const { findings } = await scan({
      "project.toml":
        modern('"8.4.26"') +
        '[_.metadata.example]\nname = "BP_PHP_VERSION"\nvalue = "documentation example"\n',
    })
    expect(findings).toContainEqual(
      expect.objectContaining({
        cve: "CVE-2026-109618",
        dependency_metadata: expect.objectContaining({ runtime_version: "8.4.26" }),
      })
    )
  })

  it.each([
    [".php-version", "8.4.27\n"],
    ["project.toml", modern('"8.4.27"')],
  ])("does not flag the patched declaration in %s", async (path, content) => {
    const { findings } = await scan({ [path!]: content! })
    expect(findings.some((finding) => finding.cve === "CVE-2026-109618")).toBe(false)
  })

  it.each([".php-version", "project.toml"])("does not follow a symlinked %s", async (path) => {
    const { root } = await scan({})
    const outside = await mkdtemp(join(tmpdir(), "php-declaration-outside-"))
    directories.push(outside)
    await writeFile(
      join(outside, "input"),
      path === ".php-version" ? "8.4.26\n" : modern('"8.4.26"')
    )
    await symlink(join(outside, "input"), join(root, path))
    const issues: ScannerCoverageIssue[] = []
    const findings = await scanIac({ repoPath: root, workspaceDir: root, coverageIssues: issues })
    expect(findings).toEqual([])
    expect(issues.some((issue) => /symlink/i.test(issue.reason))).toBe(true)
  })

  it("retains bounded discovery for oversized and deeply nested new inputs", async () => {
    const { findings, issues } = await scan({
      "project.toml": " ".repeat(512 * 1024 + 1),
      [`${"d/".repeat(42)}.php-version`]: "8.4.26\n",
    })
    expect(findings).toEqual([])
    expect(issues.some((issue) => issue.status === "bounded")).toBe(true)
  })

  it("bounds direct descriptor parsing below the general IaC file limit", () => {
    const issues: ScannerCoverageIssue[] = []
    const result = inspectPhpRuntimeInput(
      "project.toml",
      modern('"8.4.26"') + "#".repeat(64 * 1024),
      null,
      issues
    )
    expect(result.findings).toEqual([])
    expect(issues).toContainEqual(expect.objectContaining({ scanner: "iac", status: "partial" }))
  })
})
