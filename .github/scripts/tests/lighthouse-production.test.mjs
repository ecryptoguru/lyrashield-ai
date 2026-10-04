import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
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

function report(performance = 0.98, runtimeError = null) {
  return {
    finalUrl: "https://lyrashieldai.com/agents",
    runtimeError,
    categories: {
      performance: { score: performance },
      accessibility: { score: 1 },
      seo: { score: 1 },
    },
  }
}

test("recognizes the exact NO_NAVSTART runtime error", () => {
  assert.equal(hasNoNavstart(report(null, { code: "NO_NAVSTART" })), true)
  assert.equal(hasNoNavstart(null, "LighthouseError: NO_NAVSTART"), true)
  assert.equal(hasNoNavstart(report(null, { code: "TRACE_TIMEOUT" })), false)
  assert.equal(hasNoNavstart(null, "navigation failed"), false)
})

test("retries a NO_NAVSTART once and never retries a second time", () => {
  const failure = report(null, { code: "NO_NAVSTART" })
  assert.equal(shouldRetryNoNavstart({ report: failure, attempt: 1 }), true)
  assert.equal(shouldRetryNoNavstart({ report: failure, attempt: 2 }), false)
})

test("does not retry other runtime errors or real score failures", () => {
  assert.equal(
    shouldRetryNoNavstart({ report: report(null, { code: "PROTOCOL_TIMEOUT" }), attempt: 1 }),
    false
  )
  assert.equal(shouldRetryNoNavstart({ report: report(0.79), attempt: 1 }), false)
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
        const failed = report(null, { code: "NO_NAVSTART" })
        return { report: failed, diagnostic: "NO_NAVSTART", exitCode: 1 }
      }
      return { report: report(0.98), diagnostic: "", exitCode: 0 }
    },
  })
  assert.equal(attempts.length, 2)
  assert.equal(warnings.filter((warning) => warning.includes("retrying once")).length, 1)
  assert.equal(reports._agents.categories.performance.score, 0.98)
  assert.equal(
    JSON.parse(
      readFileSync(path.join(reportsDir, "lyrashield-lighthouse_agents.json"), "utf8")
    ).categories.performance.score,
    0.98
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
      return { report: report(0.79), diagnostic: "", exitCode: 0 }
    },
  })
  assert.equal(attempts, 1)
  assert.equal(evaluateLighthouseReports(reports).failed, true)
})
