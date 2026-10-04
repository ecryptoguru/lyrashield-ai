import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import {
  collectLighthouseReports,
  evaluateLighthouseReports,
  hasNoNavstart,
  LIGHTHOUSE_MINIMUM,
  LIGHTHOUSE_PAGES,
  shouldRetryNoNavstart,
} from "../lighthouse-production.mjs"

function report(
  performance = 0.98,
  runtimeError = null,
  finalUrl = "https://lyrashieldai.com/agents"
) {
  return {
    finalUrl,
    runtimeError,
    categories: {
      performance: { score: performance },
      accessibility: { score: 1 },
      seo: { score: 1 },
    },
  }
}

function reportWithoutScores(runtimeError) {
  return {
    finalUrl: "https://lyrashieldai.com/agents",
    runtimeError,
    categories: {
      performance: { score: null },
      accessibility: { score: null },
      seo: { score: null },
    },
  }
}

test("recognizes the exact NO_NAVSTART runtime error", () => {
  assert.equal(hasNoNavstart(report(null, { code: "NO_NAVSTART" })), true)
  assert.equal(hasNoNavstart(null, "LighthouseError: NO_NAVSTART"), true)
  assert.equal(hasNoNavstart(report(null, { code: "TRACE_TIMEOUT" })), false)
  assert.equal(
    hasNoNavstart(report(null, { code: "PROTOCOL_TIMEOUT" }), "NO_NAVSTART in diagnostics"),
    false
  )
  assert.equal(hasNoNavstart(null, "navigation failed"), false)
})

test("retries a NO_NAVSTART once and never retries a second time", () => {
  const failure = reportWithoutScores({ code: "NO_NAVSTART" })
  assert.equal(shouldRetryNoNavstart({ report: failure, attempt: 1 }), true)
  assert.equal(shouldRetryNoNavstart({ report: failure, attempt: 2 }), false)
})

test("does not retry other runtime errors or real score failures", () => {
  assert.equal(
    shouldRetryNoNavstart({
      report: report(null, { code: "PROTOCOL_TIMEOUT" }),
      attempt: 1,
    }),
    false
  )
  assert.equal(
    shouldRetryNoNavstart({
      report: report(null, { code: "PROTOCOL_TIMEOUT" }),
      diagnostic: "NO_NAVSTART in diagnostics",
      attempt: 1,
    }),
    false
  )
  assert.equal(shouldRetryNoNavstart({ report: report(0.79), attempt: 1 }), false)
  assert.equal(
    shouldRetryNoNavstart({
      report: report(0.79),
      diagnostic: "NO_NAVSTART appeared after a complete report",
      attempt: 1,
    }),
    false
  )
  const partial = report(0.79)
  partial.categories.accessibility.score = null
  assert.equal(
    shouldRetryNoNavstart({
      report: partial,
      diagnostic: "NO_NAVSTART appeared after a partial report",
      attempt: 1,
    }),
    false
  )
  assert.equal(LIGHTHOUSE_MINIMUM.performance, 0.8)
})

test("a homepage score below 0.80 still fails while 0.80 passes", () => {
  const reports = Object.fromEntries(
    LIGHTHOUSE_PAGES.map((page) => [
      page.name,
      {
        finalUrl: "https://lyrashieldai.com" + page.path,
        categories: {
          performance: { score: page.path === "/" ? 0.79 : 0.98 },
          accessibility: { score: 1 },
          seo: { score: 1 },
        },
      },
    ])
  )
  assert.equal(evaluateLighthouseReports(reports).failed, true)
  reports._.categories.performance.score = 0.8
  assert.equal(evaluateLighthouseReports(reports).failed, false)
})

test("retries exactly once for NO_NAVSTART and retains the successful report", async (t) => {
  const reportsDir = mkdtempSync(path.join(tmpdir(), "lyra-lighthouse-retry-"))
  t.after(() => rmSync(reportsDir, { recursive: true, force: true }))
  const page = LIGHTHOUSE_PAGES.find((candidate) => candidate.name === "_agents")
  const attempts = []
  const warnings = []
  const reports = await collectLighthouseReports({
    reportsDir,
    pages: [page],
    logger: { warn: (message) => warnings.push(message) },
    invoke: async (_url, outputPath) => {
      attempts.push(outputPath)
      if (attempts.length === 1) {
        const failed = reportWithoutScores({ code: "NO_NAVSTART" })
        return { report: failed, diagnostic: "NO_NAVSTART", exitCode: 1 }
      }
      return { report: report(0.98), diagnostic: "", exitCode: 0 }
    },
  })
  assert.equal(attempts.length, 2)
  assert.equal(warnings.filter((warning) => warning.includes("retrying once")).length, 1)
  assert.equal(reports._agents.categories.performance.score, 0.98)
  assert.equal(
    JSON.parse(readFileSync(path.join(reportsDir, "lyrashield-lighthouse_agents.json"), "utf8"))
      .categories.performance.score,
    0.98
  )
  const attemptsDir = path.join(reportsDir, "attempts")
  const firstStem = "lyrashield-lighthouse_agents.attempt-1"
  const secondStem = "lyrashield-lighthouse_agents.attempt-2"
  assert.equal(
    JSON.parse(readFileSync(path.join(attemptsDir, firstStem + ".json"), "utf8")).runtimeError.code,
    "NO_NAVSTART"
  )
  assert.match(
    readFileSync(path.join(attemptsDir, firstStem + ".diagnostic.txt"), "utf8"),
    /NO_NAVSTART/
  )
  assert.equal(
    JSON.parse(readFileSync(path.join(attemptsDir, firstStem + ".metadata.json"), "utf8")).exitCode,
    1
  )
  assert.match(
    readFileSync(path.join(attemptsDir, secondStem + ".diagnostic.txt"), "utf8"),
    /no CLI diagnostic output/
  )
})

test("a low but valid score is not retried and remains a gate failure", async (t) => {
  const reportsDir = mkdtempSync(path.join(tmpdir(), "lyra-lighthouse-score-"))
  t.after(() => rmSync(reportsDir, { recursive: true, force: true }))
  const page = LIGHTHOUSE_PAGES.find((candidate) => candidate.path === "/")
  let attempts = 0
  const reports = await collectLighthouseReports({
    reportsDir,
    pages: [page],
    logger: { warn() {} },
    invoke: async () => {
      attempts += 1
      return {
        report: report(0.79, null, "https://lyrashieldai.com/"),
        diagnostic: "NO_NAVSTART appeared after a complete measurement",
        exitCode: 1,
      }
    },
  })
  assert.equal(attempts, 1)
  assert.equal(evaluateLighthouseReports(reports).failed, true)
})

test("a finite category score with a NO_NAVSTART runtime error is retained and assessed", async (t) => {
  const reportsDir = mkdtempSync(path.join(tmpdir(), "lyra-lighthouse-partial-"))
  t.after(() => rmSync(reportsDir, { recursive: true, force: true }))
  const page = LIGHTHOUSE_PAGES.find((candidate) => candidate.path === "/agents")
  let attempts = 0
  const reports = await collectLighthouseReports({
    reportsDir,
    pages: [page],
    logger: { warn() {} },
    invoke: async (url) => {
      attempts += 1
      return {
        report: {
          finalUrl: url,
          runtimeError: { code: "NO_NAVSTART" },
          categories: {
            performance: { score: null },
            accessibility: { score: 0.9 },
            seo: { score: 1 },
          },
        },
        diagnostic: "NO_NAVSTART",
        exitCode: 1,
      }
    },
  })
  assert.equal(attempts, 1)
  assert.equal(reports._agents.categories.accessibility.score, 0.9)
  const evaluation = evaluateLighthouseReports(reports)
  assert.equal(evaluation.failed, true)
  assert.ok(
    evaluation.messages.includes(
      "FAIL https://lyrashieldai.com/agents accessibility: 0.9 (min 0.95)"
    )
  )
  assert.ok(evaluation.messages.includes("ok   https://lyrashieldai.com/agents seo: 1 (min 0.95)"))
})

test("runtime errors fail closed while retaining every route's category scores", async (t) => {
  const reportsDir = mkdtempSync(path.join(tmpdir(), "lyra-lighthouse-runtime-error-"))
  t.after(() => rmSync(reportsDir, { recursive: true, force: true }))
  const origin = "https://lyrashieldai.com"
  const invocations = []
  const reports = await collectLighthouseReports({
    reportsDir,
    origin,
    logger: { warn() {} },
    invoke: async (url) => {
      invocations.push(url)
      const result = report(0.98, null, url)
      if (url.endsWith("/agents")) result.runtimeError = { code: "PROTOCOL_TIMEOUT" }
      return {
        report: result,
        diagnostic: url.endsWith("/agents") ? "NO_NAVSTART in diagnostic output" : "",
        exitCode: url.endsWith("/agents") ? 1 : 0,
      }
    },
  })
  assert.deepEqual(
    invocations,
    LIGHTHOUSE_PAGES.map((page) => new URL(page.path, origin).toString())
  )
  assert.equal(Object.keys(reports).length, LIGHTHOUSE_PAGES.length)
  assert.equal(reports._agents.categories.accessibility.score, 1)
  const evaluation = evaluateLighthouseReports(reports)
  assert.equal(evaluation.failed, true)
  assert.equal(evaluation.messages.filter((message) => message.startsWith("ok   ")).length, 15)
  assert.ok(
    evaluation.messages.includes(
      "FAIL https://lyrashieldai.com/agents runtimeError: PROTOCOL_TIMEOUT"
    )
  )
  assert.match(evaluation.summary, /runtimeError: PROTOCOL_TIMEOUT/)
})

test("retries a thrown NO_NAVSTART instrumentation failure only once", async (t) => {
  const reportsDir = mkdtempSync(path.join(tmpdir(), "lyra-lighthouse-thrown-"))
  t.after(() => rmSync(reportsDir, { recursive: true, force: true }))
  const page = LIGHTHOUSE_PAGES.find((candidate) => candidate.path === "/agents")
  let attempts = 0
  const reports = await collectLighthouseReports({
    reportsDir,
    pages: [page],
    logger: { warn() {} },
    invoke: async (url) => {
      attempts += 1
      if (attempts === 1) throw new Error("Lighthouse instrumentation failed: NO_NAVSTART")
      return { report: report(0.79, null, url), diagnostic: "", exitCode: 0 }
    },
  })
  assert.equal(attempts, 2)
  assert.equal(reports._agents.categories.performance.score, 0.79)
  assert.equal(evaluateLighthouseReports(reports).failed, true)
  assert.match(
    readFileSync(
      path.join(reportsDir, "attempts", "lyrashield-lighthouse_agents.attempt-1.diagnostic.txt"),
      "utf8"
    ),
    /NO_NAVSTART/
  )
  const secondMetadata = JSON.parse(
    readFileSync(
      path.join(reportsDir, "attempts", "lyrashield-lighthouse_agents.attempt-2.metadata.json"),
      "utf8"
    )
  )
  assert.equal(secondMetadata.attempt, 2)
  assert.equal(secondMetadata.maxAttempts, 2)
})

test("an invalid report fails closed while all required routes are still measured", async (t) => {
  const reportsDir = mkdtempSync(path.join(tmpdir(), "lyra-lighthouse-invalid-"))
  t.after(() => rmSync(reportsDir, { recursive: true, force: true }))
  const origin = "https://lyrashieldai.com"
  const invocations = []
  const reports = await collectLighthouseReports({
    reportsDir,
    origin,
    logger: { warn() {} },
    invoke: async (url, outputPath) => {
      invocations.push(url)
      if (url.endsWith("/scan")) {
        writeFileSync(outputPath, "{invalid json")
        return { diagnostic: "SyntaxError: invalid report JSON", exitCode: 1 }
      }
      return {
        report: {
          finalUrl: url,
          categories: {
            performance: { score: 0.98 },
            accessibility: { score: 1 },
            seo: { score: 1 },
          },
        },
        diagnostic: "",
        exitCode: 0,
      }
    },
  })
  assert.deepEqual(
    invocations,
    LIGHTHOUSE_PAGES.map((page) => new URL(page.path, origin).toString())
  )
  assert.equal(Object.keys(reports).length, LIGHTHOUSE_PAGES.length - 1)
  assert.equal(evaluateLighthouseReports(reports).failed, true)
  assert.ok(
    existsSync(path.join(reportsDir, "attempts", "lyrashield-lighthouse_scan.attempt-1.json"))
  )
  const invalidMetadata = JSON.parse(
    readFileSync(
      path.join(reportsDir, "attempts", "lyrashield-lighthouse_scan.attempt-1.metadata.json"),
      "utf8"
    )
  )
  assert.equal(invalidMetadata.reportParsed, false)
  assert.equal(invalidMetadata.reportFile, "lyrashield-lighthouse_scan.attempt-1.json")
  assert.match(
    readFileSync(
      path.join(reportsDir, "attempts", "lyrashield-lighthouse_scan.attempt-1.diagnostic.txt"),
      "utf8"
    ),
    /invalid report JSON/
  )
})
