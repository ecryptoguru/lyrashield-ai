/* eslint-disable security/detect-non-literal-fs-filename */
//
// Drift guard: root `action.yml` embeds bash (grep -E) mirrors of the
// risky-pattern detector rules whose source of truth is
// `packages/cli/src/diff-core.ts` (RISKY_PATTERNS). The action stays
// self-contained so it can run on CI images without a Node runtime, which is
// why the duplication exists at all. This test fails when the two copies
// diverge on rule IDs, regexes, severities, SARIF levels, or messages —
// change both files together (diff-core.ts first).
//
// Intentional, documented differences that are normalized or out of scope:
// - Bash regex quoting: a literal `'` inside the single-quoted grep pattern
//   is written as the escape sequence '"'"' and is unescaped before compare.
// - POSIX classes: `[[:space:]]` is treated as equivalent to JS `\s` and
//   `[:alnum:]_` (as used inside `[^.[:alnum:]_]`) as equivalent to JS `\w`.
//   (Pedantically, JS `\s` also matches a few Unicode whitespace characters
//   such as NBSP that POSIX `[[:space:]]` does not; accepted platform gap.)
// - Case-insensitivity is asserted to match: every action check must use
//   `grep -qi` because every diff-core pattern compiles with the `i` flag.
// - The SARIF driver name/version and the gitleaks secret-detection step are
//   intentionally action-specific and are not guarded here.
//
import { describe, expect, it } from "vitest"
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { RISKY_PATTERNS } from "../diff-core.js"

interface ActionCheck {
  ruleId: string
  level: string
  message: string
  severity: string
  pattern: string
  caseInsensitive: boolean
}

/** Un-escape a single-quoted bash grep pattern into a plain regex string. */
function bashPatternToJs(raw: string): string {
  // `[[:space:]]` and `[:alnum:]_` (as in `[^.[:alnum:]_]`) are the POSIX
  // spellings of the JS `\s` and `\w` shorthands used by diff-core.ts.
  return raw
    .replaceAll("'\"'\"'", "'")
    .replaceAll("[[:space:]]", "\\s")
    .replaceAll("[:alnum:]_", "\\w")
}

async function extractActionChecks(): Promise<ActionCheck[]> {
  // action.yml lives at the repository root, four levels above this file.
  const actionPath = fileURLToPath(new URL("../../../../action.yml", import.meta.url))
  const yml = await readFile(actionPath, "utf-8")

  const checks: ActionCheck[] = []
  const lines = yml.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const grepMatch = lines[i]?.match(/^\s*if grep -q(i?)E '(.*)' <<< "\$ADDED"; then\s*$/)
    if (!grepMatch) continue
    const addMatch = lines[i + 1]?.match(
      /^\s*add_result "([a-z0-9-]+)" "(error|warning)" "([^"]*)" "\$file"; ISSUES=1; ISSUES_SEVERITY=\$\(bump_severity "\$ISSUES_SEVERITY" "([A-Z]+)"\)\s*$/
    )
    if (!addMatch) {
      throw new Error(
        `action.yml risky-pattern check at line ${i + 1} does not have the expected add_result/` +
          `bump_severity continuation on the next line — update this drift guard alongside the action.`
      )
    }
    checks.push({
      caseInsensitive: grepMatch[1] === "i",
      pattern: bashPatternToJs(grepMatch[2] ?? ""),
      ruleId: addMatch[1] ?? "",
      level: addMatch[2] ?? "",
      message: addMatch[3] ?? "",
      severity: addMatch[4] ?? "",
    })
  }
  return checks
}

describe("action.yml risky-pattern drift guard (source of truth: src/diff-core.ts)", () => {
  it("finds one action check per diff-core pattern", async () => {
    const checks = await extractActionChecks()
    expect(RISKY_PATTERNS.length).toBeGreaterThan(0)
    // Guards against a silent vacuous pass if the gate step is ever
    // restructured so the extraction regex stops matching anything.
    expect(checks.length).toBe(RISKY_PATTERNS.length)

    expect([...checks].map((c) => c.ruleId).sort()).toEqual(
      [...RISKY_PATTERNS].map((p) => p.ruleId).sort()
    )
  })

  it("keeps every action regex identical to its diff-core regex", async () => {
    const checks = await extractActionChecks()
    for (const check of checks) {
      const tsPattern = RISKY_PATTERNS.find((p) => p.ruleId === check.ruleId)
      expect(
        tsPattern,
        `action rule "${check.ruleId}" missing from diff-core RISKY_PATTERNS`
      ).toBeDefined()
      expect(check.pattern, `regex drift for rule "${check.ruleId}"`).toBe(tsPattern?.regex.source)
    }
  })

  it("keeps case-insensitivity aligned (diff-core /i vs grep -qi)", async () => {
    const checks = await extractActionChecks()
    for (const check of checks) {
      const tsPattern = RISKY_PATTERNS.find((p) => p.ruleId === check.ruleId)
      expect(
        tsPattern?.regex.flags,
        `diff-core rule "${check.ruleId}" must keep the i flag`
      ).toContain("i")
      expect(
        check.caseInsensitive,
        `action rule "${check.ruleId}" must use grep -qi to match diff-core's case-insensitive regex`
      ).toBe(true)
    }
  })

  it("keeps severities, SARIF levels, and messages aligned", async () => {
    const checks = await extractActionChecks()
    for (const check of checks) {
      const tsPattern = RISKY_PATTERNS.find((p) => p.ruleId === check.ruleId)
      expect(check.severity, `severity drift for rule "${check.ruleId}"`).toBe(tsPattern?.severity)
      // Mirrors the level derivation in runRiskyPatternChecks().
      const expectedLevel =
        tsPattern?.severity === "HIGH" || tsPattern?.severity === "CRITICAL" ? "error" : "warning"
      expect(check.level, `SARIF level drift for rule "${check.ruleId}"`).toBe(expectedLevel)
      expect(
        check.message.replaceAll("$file", "FILE"),
        `message drift for rule "${check.ruleId}"`
      ).toBe(tsPattern?.message("FILE"))
    }
  })
})

describe("action.yml v2 scan-mode contract", () => {
  it("rejects reserved DEEP mode instead of running SAFE-equivalent coverage", async () => {
    const actionPath = fileURLToPath(new URL("../../../../action.yml", import.meta.url))
    const yml = await readFile(actionPath, "utf-8")

    expect(yml).not.toContain("SAFE-equivalent")
    expect(yml).toContain("SAFE|AGGRESSIVE) ;;")
    expect(yml).toContain('DEEP) echo "::error::scan_mode DEEP requires the hosted LyraShield')
  })

  it("advances v2 after green main while leaving v1 frozen", async () => {
    const workflowsDir = fileURLToPath(new URL("../../../../.github/workflows/", import.meta.url))
    const workflowFiles = (await readdir(workflowsDir)).filter((file) => /\.ya?ml$/.test(file))
    const workflows = await Promise.all(
      workflowFiles.map(async (file) => readFile(`${workflowsDir}/${file}`, "utf-8"))
    )
    const releaseWorkflow = await readFile(`${workflowsDir}/update-action-version.yml`, "utf-8")

    expect(workflows.some((workflow) => workflow.includes("git tag -fa v1"))).toBe(false)
    expect(workflows.some((workflow) => workflow.includes("git push origin v1 --force"))).toBe(
      false
    )
    expect(workflows.some((workflow) => workflow.includes("SAFE-equivalent"))).toBe(false)
    expect(releaseWorkflow).toContain(
      'git tag -fa v2 -m "Update v2 tag to ${HEAD_SHA}" "$HEAD_SHA"'
    )
    expect(releaseWorkflow).toContain("git push origin v2 --force")
  })
})
