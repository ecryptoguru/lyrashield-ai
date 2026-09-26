/**
 * Tests for scripts/webmcp-runtime-check.mjs.
 *
 * Unit tests cover pure argument/target helpers. Runner end-to-end tests
 * spawn the real CLI via child_process against the checked-in fixtures and
 * validate the emitted receipt with the real zod schema — skipped only when
 * no Playwright Chromium binary is installed (e.g. minimal CI images).
 */

import { describe, it, expect, beforeAll } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  parseArgs,
  resolveAbsoluteTarget,
  listFixturePages,
  checksumFixtureSet,
  renderMarkdown,
  CliError,
} from "./webmcp-runtime-check.mjs"
import {
  sanitizeOrigin,
  validateWebMcpRuntimeReceipt,
  WEBMCP_RUNTIME_CHECK_IDS as IDS,
} from "../packages/security/src/webmcp/runtime-receipt.ts"

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url))
const RUNNER = path.join(REPO_ROOT, "scripts/webmcp-runtime-check.mjs")
const FIXTURE_DIR = path.join(REPO_ROOT, "e2e/webmcp-runtime/fixtures")

// Node emits a one-time typeless-package warning when the runner imports the
// shared TS contract; it is cosmetic stderr noise, not an error.
const TYPELESS_WARNING_RE =
  /\(node:\d+\) \[MODULE_TYPELESS_PACKAGE_JSON\][\s\S]*?warning was created\)\n?/g

function stripKnownWarnings(stderr) {
  return stderr.replace(TYPELESS_WARNING_RE, "")
}

function runRunner(argv, { timeout = 90_000 } = {}) {
  return spawnSync("node", [RUNNER, ...argv], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout,
    env: { ...process.env },
  })
}

function tmpOut() {
  const dir = mkdtempSync(path.join(tmpdir(), "webmcp-runtime-test-"))
  return { dir, json: path.join(dir, "receipt.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

let chromiumAvailable = false
beforeAll(async () => {
  try {
    const { chromium } = await import("@playwright/test")
    chromiumAvailable = existsSync(chromium.executablePath())
  } catch {
    chromiumAvailable = false
  }
})

describe("parseArgs", () => {
  it("requires a fixture dir or target", () => {
    expect(() => parseArgs([])).toThrow(CliError)
    expect(() => parseArgs(["--timeout-ms", "5000"])).toThrow(/fixture-dir|target/)
  })

  it("pairs --active-input/--active-abort-ms with the preceding --active-tool", () => {
    const args = parseArgs([
      "--fixture-dir", "f",
      "--active-tool", "a_tool",
      "--active-input", '{"x":1}',
      "--active-tool", "b_tool",
      "--active-abort-ms", "250",
    ])
    expect(args.activeTools).toEqual([
      { name: "a_tool", input: { x: 1 }, abortAfterMs: undefined },
      { name: "b_tool", input: {}, abortAfterMs: 250 },
    ])
  })

  it("rejects dangling --active-input, bad JSON, non-object input, and duplicate tools", () => {
    expect(() => parseArgs(["--fixture-dir", "f", "--active-input", "{}"])).toThrow(CliError)
    expect(() =>
      parseArgs(["--fixture-dir", "f", "--active-tool", "t", "--active-input", "nope"])
    ).toThrow(/JSON/)
    expect(() =>
      parseArgs(["--fixture-dir", "f", "--active-tool", "t", "--active-input", "[1]"])
    ).toThrow(/JSON object/)
    expect(() =>
      parseArgs(["--fixture-dir", "f", "--active-tool", "t", "--active-tool", "t"])
    ).toThrow(/twice/)
  })

  it("rejects unknown flags, positionals, and out-of-range timeouts", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag/)
    expect(() => parseArgs(["--fixture-dir", "f", "pos"])).toThrow(/positional/)
    expect(() => parseArgs(["--fixture-dir", "f", "--timeout-ms", "5"])).toThrow(/timeout-ms/)
  })
})

describe("resolveAbsoluteTarget", () => {
  it("accepts absolute http(s) targets and returns the canonical origin", () => {
    expect(resolveAbsoluteTarget("https://Example.COM:443/a?b#c", sanitizeOrigin)).toEqual({
      url: "https://Example.COM:443/a?b#c",
      origin: "https://example.com",
    })
  })

  it("rejects loopback and userinfo targets", () => {
    for (const raw of [
      "http://127.0.0.1:9999/x",
      "http://localhost:3000/",
      "https://user:pw@example.com/",
      "ftp://example.com/x",
    ]) {
      expect(() => resolveAbsoluteTarget(raw, sanitizeOrigin)).toThrow(CliError)
    }
  })
})

describe("fixture helpers", () => {
  it("lists only top-level html fixture pages", async () => {
    const pages = await listFixturePages(FIXTURE_DIR)
    expect(pages).toEqual([
      "abort-signal.html",
      "human-confirm.html",
      "invalid-input.html",
      "no-webmcp.html",
      "registered-tools.html",
      "undeclared-subresource.html",
    ])
  })

  it("checksums the fixture set deterministically", async () => {
    const a = await checksumFixtureSet(FIXTURE_DIR)
    const b = await checksumFixtureSet(FIXTURE_DIR)
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(a.digest).toBe(b.digest)
    expect(a.fileCount).toBeGreaterThanOrEqual(8)
  })

  it("renders a markdown report containing check rows and the overall state", () => {
    const receipt = {
      schemaVersion: "lyrashield-webmcp-runtime/1",
      runId: "r1",
      checkedAt: "2026-09-26T00:00:00.000Z",
      browser: { name: "chromium", version: "1", nativeApiAvailable: false },
      target: { origin: "http://127.0.0.1:1" },
      checks: [
        { id: "webmcp.fixture-load:x.html", state: "PASS", method: "native-browser", summary: "loaded" },
      ],
      limits: { timedOut: false, skipped: [] },
    }
    const md = renderMarkdown(receipt, {
      overall: "PASS",
      counts: { PASS: 1, FAIL: 0, INCONCLUSIVE: 0, NOT_APPLICABLE: 0 },
    })
    expect(md).toContain("webmcp.fixture-load:x.html")
    expect(md).toContain("**PASS**")
  })
})

describe("cli argument errors", () => {
  it("exits 2 on unknown flag", () => {
    const res = runRunner(["--bogus-flag"])
    expect(res.status).toBe(2)
    expect(res.stderr).toMatch(/unknown flag/)
  })

  it("exits 2 when neither fixture dir nor target is given", () => {
    const res = runRunner([])
    expect(res.status).toBe(2)
  })

  it("exits 2 on a loopback --allow-origin (only the fixture server may be loopback)", () => {
    const res = runRunner([
      "--fixture-dir", FIXTURE_DIR,
      "--allow-origin", "http://127.0.0.1:9999",
      "--target", "/no-webmcp.html",
    ])
    expect(res.status).toBe(2)
    expect(res.stderr).toMatch(/loopback/i)
  })

  it("exits 2 on a target that escapes the fixture dir", () => {
    const res = runRunner(["--fixture-dir", FIXTURE_DIR, "--target", "/../../etc/passwd"])
    expect(res.status).toBe(2)
  })
})

describe("runner end-to-end (requires a Playwright chromium binary)", () => {
  it("produces a schema-valid receipt with honest PASS/INCONCLUSIVE/FAIL split", { timeout: 120_000 }, () => {
    if (!chromiumAvailable) return
    const out = tmpOut()
    try {
      const res = runRunner(["--fixture-dir", FIXTURE_DIR, "--json", out.json])
      // The undeclared-subresource trap fixture makes one check FAIL by design.
      expect(res.status).toBe(1)
      expect(stripKnownWarnings(res.stderr)).toBe("")
      expect(res.stdout).toMatch(/overall: FAIL/)

      const receipt = JSON.parse(readFileSync(out.json, "utf8"))
      const validation = validateWebMcpRuntimeReceipt(receipt)
      expect(validation.ok).toBe(true)

      // Stock Chromium has no native WebMCP API: every native-dependent check
      // must be INCONCLUSIVE, never a shim-flavored PASS.
      expect(receipt.browser.nativeApiAvailable).toBe(false)
      const nativeChecks = receipt.checks.filter((c) => c.id.startsWith(IDS.nativeApi))
      expect(nativeChecks.length).toBe(6)
      for (const check of nativeChecks) {
        expect(check.state).toBe("INCONCLUSIVE")
        expect(check.summary).toMatch(/native WebMCP API unavailable in chromium/)
      }
      const enumChecks = receipt.checks.filter((c) => c.id.startsWith(IDS.toolEnumeration))
      expect(enumChecks.every((c) => c.state === "INCONCLUSIVE")).toBe(true)

      // Harness checks still execute and PASS.
      const loads = receipt.checks.filter((c) => c.id.startsWith(IDS.fixtureLoad))
      expect(loads.length).toBe(6)
      expect(loads.every((c) => c.state === "PASS")).toBe(true)

      // The trap fixture: undeclared subresource attempts blocked + recorded.
      const trap = receipt.checks.find((c) =>
        c.id === `${IDS.declaredOrigins}:undeclared-subresource.html`
      )
      expect(trap?.state).toBe("FAIL")
      expect(trap?.summary).toMatch(/undeclared-a\.invalid/)
      expect(trap?.summary).toMatch(/blocked/)

      // Passive mode never executed the mutating-looking tool.
      const passive = receipt.checks.find(
        (c) => c.id === `${IDS.passiveNoExecution}:registered-tools.html`
      )
      expect(passive?.state).toBe("PASS")
      expect(passive?.summary).toMatch(/no tool executed/)

      // Identity bound by revision + content checksum.
      const identity = receipt.checks.find((c) => c.id === IDS.targetIdentity)
      expect(identity?.state).toBe("PASS")
      expect(receipt.target.contentChecksum).toMatch(/^[0-9a-f]{64}$/)
      // Receipt stores no cookies/tokens/raw source/IO bodies.
      const raw = JSON.stringify(receipt)
      expect(raw).not.toMatch(/cookie|token|password/i)
    } finally {
      out.cleanup()
    }
  })

  it("exits 0 on a clean PASS/INCONCLUSIVE subset; active tools are not executed without a native API", { timeout: 120_000 }, () => {
    if (!chromiumAvailable) return
    const out = tmpOut()
    try {
      const res = runRunner([
        "--fixture-dir", FIXTURE_DIR,
        "--target", "/registered-tools.html",
        "--target", "/no-webmcp.html",
        "--target", "/invalid-input.html",
        "--target", "/abort-signal.html",
        "--active-tool", "fixture_strict_echo",
        "--active-input", '{"message":42}',
        "--active-tool", "fixture_slow_task",
        "--active-abort-ms", "200",
        "--json", out.json,
      ])
      expect(res.status).toBe(0)
      const receipt = JSON.parse(readFileSync(out.json, "utf8"))
      expect(validateWebMcpRuntimeReceipt(receipt).ok).toBe(true)
      expect(receipt.checks.some((c) => c.state === "FAIL")).toBe(false)

      // Declared on its fixture but native API absent → INCONCLUSIVE, never executed.
      const echoExec = receipt.checks.find(
        (c) => c.id === `${IDS.toolExecution}:invalid-input.html:fixture_strict_echo`
      )
      expect(echoExec?.state).toBe("INCONCLUSIVE")
      expect(echoExec?.summary).toMatch(/not executed/)
      const slowExec = receipt.checks.find(
        (c) => c.id === `${IDS.toolExecution}:abort-signal.html:fixture_slow_task`
      )
      expect(slowExec?.state).toBe("INCONCLUSIVE")

      // A tool not declared by a fixture is NOT_APPLICABLE there, never silently run.
      const notApplicable = receipt.checks.find(
        (c) => c.id === `${IDS.toolExecution}:no-webmcp.html:fixture_strict_echo`
      )
      expect(notApplicable?.state).toBe("NOT_APPLICABLE")

      // Passive observation still proves nothing executed anywhere.
      const passive = receipt.checks.filter((c) => c.id.startsWith(IDS.passiveNoExecution))
      expect(passive.every((c) => c.state === "PASS" || c.state === "NOT_APPLICABLE")).toBe(true)
    } finally {
      out.cleanup()
    }
  })

  it("marks an allowlisted tool missing everywhere as FAIL (exit 1)", { timeout: 120_000 }, () => {
    if (!chromiumAvailable) return
    const out = tmpOut()
    try {
      const res = runRunner([
        "--fixture-dir", FIXTURE_DIR,
        "--target", "/no-webmcp.html",
        "--active-tool", "fixture_never_registered",
        "--json", out.json,
      ])
      expect(res.status).toBe(1)
      const receipt = JSON.parse(readFileSync(out.json, "utf8"))
      const check = receipt.checks.find(
        (c) => c.id === `${IDS.toolExecution}:fixture_never_registered`
      )
      expect(check?.state).toBe("FAIL")
      expect(check?.summary).toMatch(/never registered/)
    } finally {
      out.cleanup()
    }
  })
})
