import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { scanIac } from "./iac-scanner"
import { inspectPhpRuntimeInput } from "./php-runtime"
import type { ScannerCoverageIssue } from "../scanner-coverage"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
async function scan(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "php-runtime-"))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), content)
  }
  const issues: ScannerCoverageIssue[] = []
  const findings = await scanIac({ repoPath: dir, workspaceDir: dir, coverageIssues: issues })
  return {
    dir,
    issues,
    findings: findings.filter((f) => f.finding_class?.startsWith("php_runtime_")),
  }
}

describe("passive declared PHP runtime detection", () => {
  it("withholds full-file edits above 256 lines while retaining CVE detection and guidance", async () => {
    const content = "FROM php:8.4.26-fpm\n" + "\n".repeat(399)
    expect(content.length).toBeLessThan(16000)
    const { findings } = await scan({ Dockerfile: content })
    const finding = findings.find((entry) => entry.cve === "CVE-2026-109618")
    expect(finding).toBeDefined()
    expect(finding?.code_locations?.[0]).not.toHaveProperty("fix_before")
    expect(finding?.code_locations?.[0]).not.toHaveProperty("fix_after")
    expect(finding?.remediation_steps).toContain("rebuild, deploy and restart every replica")
  })

  it.each([
    ["8.2.34", "8.2.35"],
    ["8.3.35", "8.3.36"],
    ["8.4.26", "8.4.27"],
    ["8.5.11", "8.5.12"],
  ])("matches exact branch %s and generates a full-file safe tag edit", async (version, fixed) => {
    const content = `FROM php:${version}-fpm-alpine AS app\nUSER www-data\n`
    const { findings } = await scan({ Dockerfile: content })
    const f = findings.find((f) => f.cve === "CVE-2026-109618")
    expect(f).toMatchObject({
      finding_class: "php_runtime_cve",
      scannerSource: "iac",
      dependency_metadata: {
        runtime_version: version,
        evidence_scope: "source_declaration",
        fixed_version: fixed,
      },
    })
    expect(f?.code_locations?.[0]).toMatchObject({
      fix_before: content,
      fix_after: content.replace(version, fixed),
    })
    expect(f?.remediation_steps).toMatch(/rebuild.*deploy.*restart/i)
  })
  it.each(["8.2.35", "8.3.36", "8.4.27", "8.5.12"])("does not flag patched %s", async (version) => {
    expect(
      (await scan({ Dockerfile: `FROM php:${version}-fpm\nUSER www-data\n` })).findings.filter(
        (f) => f.finding_class === "php_runtime_cve"
      )
    ).toEqual([])
  })
  it.each(["8.4", "8.4.27RC1", "latest", "${PHP_VERSION}"])(
    "records unusable identity %s",
    async (tag) => {
      const { issues, findings } = await scan({ Dockerfile: `FROM php:${tag}-fpm\n` })
      expect(issues.some((i) => /PHP.*identity/i.test(i.reason))).toBe(true)
      expect(findings.filter((f) => f.finding_class === "php_runtime_cve")).toEqual([])
    }
  )
  it("does not synthesize digests or infer custom image versions", async () => {
    const { findings, issues } = await scan({
      Dockerfile: `FROM php:8.4.26-fpm@sha256:${"a".repeat(64)}\nFROM company/php-app:8.4.26\n`,
      "app.php": "<?php exit(1);",
    })
    expect(
      findings.find((f) => f.cve === "CVE-2026-109618")?.code_locations?.[0]?.fix_after
    ).toBeUndefined()
    expect(issues.some((i) => /custom|unknown/i.test(i.reason))).toBe(true)
  })
  it("handles Compose and Composer platform declarations without installed-runtime claims", async () => {
    const { findings } = await scan({
      "compose.yml": "services:\n  web:\n    image: php:8.4.26-apache\n",
      "composer.json": JSON.stringify({ config: { platform: { php: "8.3.35" } } }),
    })
    expect(
      findings
        .filter((f) => f.cve === "CVE-2026-109618")
        .map((f) => f.dependency_metadata?.runtime_version)
        .sort()
    ).toEqual(["8.3.35", "8.4.26"])
    expect(findings.every((f) => !/installed PHP/i.test(f.description ?? ""))).toBe(true)
  })
  it("keeps reported backports unverified and respects extension/SAPI exclusions", async () => {
    const { findings, issues } = await scan({
      "php-runtime.json": JSON.stringify({
        schemaVersion: 1,
        version: "8.4.20",
        sapi: "cli",
        extensions: [],
        os: "linux",
        vendorPackage: "php8.4-cli-1",
        backports: ["CVE-2026-109618"],
        replicas: 2,
      }),
    })
    expect(findings.find((f) => f.cve === "CVE-2026-109618")).toMatchObject({
      dependency_metadata: { evidence_scope: "user_reported", backport_claimed: true },
    })
    expect(
      findings.some(
        (f) => f.cve === "CVE-2026-7261" || f.cve === "CVE-2026-6735" || f.cve === "CVE-2026-17545"
      )
    ).toBe(false)
    expect(issues.some((i) => /backport/i.test(i.reason))).toBe(true)
  })
  it("reports EOL with a supported upgrade and no automatic major edit", async () => {
    const { findings } = await scan({ Dockerfile: "FROM php:7.3.10-fpm\n" })
    expect(findings.some((f) => f.finding_class === "php_runtime_eol")).toBe(true)
    expect(findings.some((f) => f.cve === "CVE-2019-11043")).toBe(true)
    expect(findings.every((f) => !f.code_locations?.[0]?.fix_after)).toBe(true)
  })
  it("records missing identity from PHP source without executing it", async () => {
    const { issues, findings } = await scan({
      "index.php": "<?php throw new Exception('must never execute');",
      "composer.json": '{"require":{"php":"^8.4"}}',
    })
    expect(findings).toEqual([])
    expect(issues.some((i) => /PHP.*identity/i.test(i.reason))).toBe(true)
  })
  it.each(["{}", '{"schemaVersion":1,"version":"8.4.26","replicas":0}', "{"])(
    "fails closed on malformed inventory %s",
    async (inventory) => {
      expect(
        (await scan({ "php-runtime.json": inventory })).issues.some((i) =>
          /PHP.*inventory/i.test(i.reason)
        )
      ).toBe(true)
    }
  )
  it("reports conservative php.ini configuration concerns", async () => {
    const { findings } = await scan({ "php.ini": "display_errors = On\nallow_url_include = 1\n" })
    expect(findings.filter((f) => f.finding_class === "php_runtime_config")).toHaveLength(2)
    expect(findings.every((f) => !f.code_locations?.[0]?.fix_after)).toBe(true)
  })
  it("does not follow a symlinked runtime inventory", async () => {
    const { dir } = await scan({ "index.php": "<?php" })
    const outside = await mkdtemp(join(tmpdir(), "php-outside-"))
    dirs.push(outside)
    await writeFile(
      join(outside, "runtime.json"),
      JSON.stringify({ schemaVersion: 1, version: "8.4.26" })
    )
    await symlink(join(outside, "runtime.json"), join(dir, "php-runtime.json"))
    const issues: ScannerCoverageIssue[] = []
    const findings = await scanIac({ repoPath: dir, workspaceDir: dir, coverageIssues: issues })
    expect(findings.some((f) => f.finding_class === "php_runtime_cve")).toBe(false)
    expect(issues.some((i) => /symlink/i.test(i.reason))).toBe(true)
  })
  it("records oversized runtime input and bounded deep discovery", async () => {
    const { issues } = await scan({
      "php-runtime.json": " ".repeat(512 * 1024 + 1),
      [`${"d/".repeat(42)}index.php`]: "<?php",
    })
    expect(issues.some((i) => i.status === "bounded")).toBe(true)
  })
})

describe("runtime identity and safe edit boundaries", () => {
  it("does not treat future 8.10 as end-of-life", async () => {
    const { findings, issues } = await scan({ Dockerfile: "FROM php:8.10.1-fpm\n" })
    expect(findings.some((f) => f.finding_class === "php_runtime_eol")).toBe(false)
    expect(issues.some((i) => /outside.*catalog/i.test(i.reason))).toBe(true)
  })
  it("reports an unsupported official-looking tag without inventing a suffix", async () => {
    const { findings, issues } = await scan({ Dockerfile: "FROM php:8.4.26-fpm-nonexistent\n" })
    expect(findings.every((f) => !f.code_locations?.[0]?.fix_after)).toBe(true)
    expect(issues.some((i) => /identity/i.test(i.reason))).toBe(true)
  })
  it("does not trust conflicting version and image identity in a runtime inventory", async () => {
    const { issues } = await scan({
      "php-runtime.json": JSON.stringify({
        schemaVersion: 1,
        version: "8.4.27",
        image: "php:8.4.26-fpm",
      }),
    })
    expect(issues.some((i) => /ambiguous|conflict/i.test(i.reason))).toBe(true)
  })
  it("does not merge unrelated PHP source trees into one runtime identity", async () => {
    const { issues } = await scan({
      "a/Dockerfile": "FROM php:8.4.27-fpm\n",
      "b/index.php": "<?php",
    })
    expect(issues.some((i) => /PHP.*identity/i.test(i.reason))).toBe(true)
  })
  it.each([
    ["8.4.4", false],
    ["8.4.5", true],
    ["8.4.25", true],
    ["8.4.26", false],
  ])("respects the introduced lower bound of CVE-2026-93682 for %s", async (version, expected) => {
    const { findings } = await scan({ Dockerfile: `FROM php:${version}-fpm\n` })
    expect(findings.some((f) => f.cve === "CVE-2026-93682")).toBe(expected)
  })
  it.each([
    ["5.3.11", "CVE-2012-1823", true],
    ["5.3.12", "CVE-2012-1823", false],
    ["7.2.23", "CVE-2019-11043", true],
    ["7.2.24", "CVE-2019-11043", false],
  ])("handles older KEV branch boundary %s", async (version, id, expected) => {
    const { findings } = await scan({
      "php-runtime.json": JSON.stringify({
        schemaVersion: 1,
        version,
        sapi: id === "CVE-2012-1823" ? "cgi" : "fpm",
      }),
    })
    expect(findings.some((f) => f.cve === id)).toBe(expected)
  })
})

describe("strict runtime declaration parser limits", () => {
  it.each([
    '{"schemaVersion":1,"version":"8.4.26","version":"8.4.27"}',
    '{"schemaVersion":1,"version":"8.4.26","extensions":["soap","soap"]}',
  ])("reports ambiguous inventory %s", async (content) => {
    const { issues } = await scan({ "php-runtime.json": content })
    expect(issues.some((i) => /malformed|ambiguous/i.test(i.reason))).toBe(true)
  })
  it("rejects duplicated Composer platform identities", async () => {
    const { issues } = await scan({
      "composer.json": '{"config":{"platform":{"php":"8.4.26","php":"8.4.27"}}}',
    })
    expect(issues.some((i) => /malformed/i.test(i.reason))).toBe(true)
  })
  it("rejects alias-based Compose runtime declarations", async () => {
    const { issues } = await scan({
      "compose.yml": "services:\n  a: &php\n    image: php:8.4.26-fpm\n  b: *php\n",
    })
    expect(issues.some((i) => /malformed|aliases/i.test(i.reason))).toBe(true)
  })
  it("retains application-first unknown extension and SAPI applicability", async () => {
    const { findings } = await scan({ "composer.json": '{"config":{"platform":{"php":"8.4.20"}}}' })
    expect(findings.find((f) => f.cve === "CVE-2026-7261")).toMatchObject({
      dependency_metadata: {
        required_extension: "soap",
        extensions: "unknown",
        required_sapi: "unspecified",
        applicability: "conditional_unverified",
      },
    })
  })
})

it("bounds runtime declaration and finding output for repeated image inputs", async () => {
  const { findings, issues } = await scan({ Dockerfile: "FROM php:8.4.0-fpm\n".repeat(2000) })
  expect(findings.length).toBeLessThanOrEqual(100)
  expect(issues.some((i) => i.status === "bounded" && /PHP runtime/i.test(i.reason))).toBe(true)
})

it("bounds in-memory runtime candidate expansion before IaC integration", () => {
  const issues: ScannerCoverageIssue[] = []
  const { findings } = inspectPhpRuntimeInput(
    "Dockerfile",
    "FROM php:8.4.0-fpm\n".repeat(2000),
    "dockerfile",
    issues
  )
  expect(findings.length).toBeLessThanOrEqual(100)
  expect(issues.some((i) => i.status === "bounded")).toBe(true)
})

it("ignores FROM literals inside Docker heredocs and continued RUN instructions", async () => {
  const { findings } = await scan({
    Dockerfile:
      "FROM node:24\nRUN cat <<'EOF' > /tmp/example\nFROM php:8.4.26-fpm\nEOF\nRUN echo \\\n FROM php:8.4.26-fpm\n",
  })
  expect(findings).toEqual([])
})
it.each(["alpine....", "alpine3..22", "alpine.3.22"])(
  "rejects malformed official suffix %s without an edit",
  async (suffix) => {
    const { findings, issues } = await scan({ Dockerfile: `FROM php:8.4.26-fpm-${suffix}\n` })
    expect(findings).toEqual([])
    expect(issues.some((issue) => /malformed/.test(issue.reason))).toBe(true)
  }
)

it.each(["FROM node:24\n", "# ordinary comment\n", "\n"])(
  "does not recognize parser directives after header boundary %j",
  (prefix) => {
    const issues: ScannerCoverageIssue[] = []
    const input = prefix + "# escape=`\nRUN echo \\\nFROM php:8.4.26-fpm\n"
    expect(inspectPhpRuntimeInput("Dockerfile", input, "dockerfile", issues).hasIdentity).toBe(
      false
    )
  }
)
it("ignores parser-like comments inside heredocs", () => {
  const input = "FROM node:24\nRUN cat <<EOF\n# escape=`\nEOF\nRUN echo \\\nFROM php:8.4.26-fpm\n"
  expect(inspectPhpRuntimeInput("Dockerfile", input, "dockerfile").hasIdentity).toBe(false)
})

it.each(["# escape = `", "# escape= `", "# escape\t=\t`"])(
  "honors Docker header whitespace in %j",
  (directive) => {
    const input = directive + "\nFROM node:24\nRUN echo `\nFROM php:8.4.26-fpm\n"
    expect(inspectPhpRuntimeInput("Dockerfile", input, "dockerfile").hasIdentity).toBe(false)
  }
)
