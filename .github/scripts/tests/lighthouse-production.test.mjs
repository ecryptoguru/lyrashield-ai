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
  LIGHTHOUSE_SAMPLE_LIMIT,
  median,
  neededSampleCount,
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

test("median takes the middle sample and averages an even count", () => {
  assert.equal(median([0.69]), 0.69)
  assert.equal(median([0.69, 0.97]), 0.83)
  assert.equal(median([0.69, 0.8, 0.97]), 0.8)
  assert.equal(median([0.97, 0.69, 0.8]), 0.8)
  assert.equal(median([0.79, 0.79, 0.98]), 0.79)
  assert.equal(median([0.79, 0.98, 0.98]), 0.98)
})

test("median ignores non-finite scores and reports null when nothing is measurable", () => {
  assert.equal(median([0.98, null, undefined]), 0.98)
  assert.equal(median([null, undefined]), null)
  assert.equal(median([]), null)
})

test("two samples that agree on pass/fail never spend a third sample", () => {
  const passing = [report(0.9), report(0.95)]
  assert.equal(neededSampleCount(passing), 2)
  const failing = [report(0.7), report(0.79)]
  assert.equal(neededSampleCount(failing), 2)
})

test("two samples that straddle a threshold ask for a tiebreaker sample", () => {
  assert.equal(neededSampleCount([report(0.79), report(0.95)]), 3)
  assert.equal(neededSampleCount([report(0.9), report(0.96)]), 2)
  // A straddle on any category counts, not just performance.
  const accessibilityStraddle = [report(0.98), report(0.98)]
  accessibilityStraddle[0].categories.accessibility.score = 0.9
  assert.equal(neededSampleCount(accessibilityStraddle), 3)
})

test("an unmeasurable category forces the tiebreaker sample and never exceeds the sample limit", () => {
  const partial = [report(0.98), report(0.98)]
  partial[0].categories.seo.score = null
  assert.equal(neededSampleCount(partial), 3)
  assert.equal(neededSampleCount([report(0.79), report(0.95), report(0.98)]), 3)
  assert.equal(
    neededSampleCount([report(0.79), report(0.95), report(0.98), report(0.9)]),
    4,
    "already-collected samples are returned unchanged once the limit is reached"
  )
})

test("the median tolerates a single flaky low sample where a one-shot gate failed", () => {
  const perPage = (scores) =>
    Object.fromEntries(
      LIGHTHOUSE_PAGES.map((page) => [
        page.name,
        scores.map((score) => ({
          finalUrl: "https://lyrashieldai.com" + page.path,
          categories: {
            performance: { score: score },
            accessibility: { score: 1 },
            seo: { score: 1 },
          },
        })),
      ])
    )

  // 0.69 was the observed homepage low; the two real samples were 0.95 and 0.97.
  assert.equal(evaluateLighthouseReports(perPage([0.69, 0.95, 0.97])).failed, false)
  assert.equal(evaluateLighthouseReports(perPage([0.69, 0.95])).failed, false)
  // Two genuinely low samples are still a failure.
  assert.equal(evaluateLighthouseReports(perPage([0.69, 0.79, 0.98])).failed, true)
})

test("a homepage median below 0.80 still fails while a median of 0.80 passes", () => {
  const reports = Object.fromEntries(
    LIGHTHOUSE_PAGES.map((page) => [
      page.name,
      [
        {
          finalUrl: "https://lyrashieldai.com" + page.path,
          categories: {
            performance: { score: page.path === "/" ? 0.79 : 0.98 },
            accessibility: { score: 1 },
            seo: { score: 1 },
          },
        },
        {
          finalUrl: "https://lyrashieldai.com" + page.path,
          categories: {
            performance: { score: page.path === "/" ? 0.8 : 0.98 },
            accessibility: { score: 1 },
            seo: { score: 1 },
          },
        },
      ],
    ])
  )
  assert.equal(evaluateLighthouseReports(reports).failed, true)
  reports._[0].categories.performance.score = 0.8
  assert.equal(evaluateLighthouseReports(reports).failed, false)
})

test("a median below a threshold fails while the passing sample stays visible", () => {
  const reports = {
    _agents: [
      report(0.79, null, "https://lyrashieldai.com/agents"),
      report(0.9, null, "https://lyrashieldai.com/agents"),
      report(0.79, null, "https://lyrashieldai.com/agents"),
    ],
  }
  const evaluation = evaluateLighthouseReports(reports)
  assert.equal(evaluation.failed, true)
  assert.ok(
    evaluation.messages.includes("FAIL https://lyrashieldai.com/agents performance: 0.79 (min 0.8)")
  )
  assert.ok(evaluation.messages.some((message) => message.startsWith("sample 1/3")))
  assert.ok(evaluation.messages.some((message) => message.startsWith("sample 3/3")))
  assert.match(evaluation.summary, /\| samples \|/)
  assert.match(evaluation.summary, /\| 3 \|/)
})

test("logs every sample and the median for each page", async (t) => {
  const reportsDir = mkdtempSync(path.join(tmpdir(), "lyra-lighthouse-median-log-"))
  t.after(() => rmSync(reportsDir, { recursive: true, force: true }))
  const origin = "https://lyrashieldai.com"
  const pricingScores = [0.79, 0.95, 0.97]
  const samplesByUrl = new Map()
  const reports = await collectLighthouseReports({
    reportsDir,
    origin,
    logger: { warn() {} },
    invoke: async (url) => {
      const taken = samplesByUrl.get(url) ?? 0
      samplesByUrl.set(url, taken + 1)
      const score = url.endsWith("/pricing") ? pricingScores[taken] : 0.98
      return {
        report: {
          finalUrl: url,
          categories: {
            performance: { score: score },
            accessibility: { score: 1 },
            seo: { score: 1 },
          },
        },
        diagnostic: "",
        exitCode: 0,
      }
    },
  })
  assert.equal(
    samplesByUrl.get(origin + "/pricing"),
    LIGHTHOUSE_SAMPLE_LIMIT,
    "a straddle must spend the tiebreaker sample"
  )
  assert.equal(reports._pricing.length, LIGHTHOUSE_SAMPLE_LIMIT)
  assert.equal(
    samplesByUrl.get(origin + "/"),
    2,
    "pages whose samples agree on pass/fail stop at two samples"
  )

  const evaluation = evaluateLighthouseReports(reports)
  assert.equal(evaluation.failed, false)
  assert.deepEqual(
    evaluation.messages.filter(
      (message) => message.startsWith("sample ") && message.includes("/pricing")
    ),
    [
      "sample 1/3 https://lyrashieldai.com/pricing performance: 0.79 accessibility: 1 seo: 1",
      "sample 2/3 https://lyrashieldai.com/pricing performance: 0.95 accessibility: 1 seo: 1",
      "sample 3/3 https://lyrashieldai.com/pricing performance: 0.97 accessibility: 1 seo: 1",
    ]
  )
  assert.ok(
    evaluation.messages.includes(
      "ok   https://lyrashieldai.com/pricing performance: 0.95 (min 0.8)"
    )
  )

  const samplesRecord = JSON.parse(
    readFileSync(path.join(reportsDir, "lyrashield-lighthouse_pricing.samples.json"), "utf8")
  )
  assert.deepEqual(samplesRecord.categories.performance.samples, [0.79, 0.95, 0.97])
  assert.equal(samplesRecord.categories.performance.median, 0.95)
  assert.equal(samplesRecord.sampled, 3)
})

test("retries exactly once for NO_NAVSTART per sample and retains the successful report", async (t) => {
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
  assert.equal(attempts.length, 3, "one retry in sample 1, then one attempt for sample 2")
  assert.equal(warnings.filter((warning) => warning.includes("retrying once")).length, 1)
  assert.equal(reports._agents.length, 2)
  assert.equal(reports._agents[0].categories.performance.score, 0.98)
  assert.equal(
    JSON.parse(readFileSync(path.join(reportsDir, "lyrashield-lighthouse_agents.json"), "utf8"))
      .categories.performance.score,
    0.98
  )
  const attemptsDir = path.join(reportsDir, "attempts")
  const firstStem = "lyrashield-lighthouse_agents.sample-1.attempt-1"
  const secondStem = "lyrashield-lighthouse_agents.sample-1.attempt-2"
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
  const sampleTwoMetadata = JSON.parse(
    readFileSync(
      path.join(attemptsDir, "lyrashield-lighthouse_agents.sample-2.attempt-1.metadata.json"),
      "utf8"
    )
  )
  assert.equal(sampleTwoMetadata.sample, 2)
  assert.equal(sampleTwoMetadata.maxAttempts, 2)
  assert.equal(sampleTwoMetadata.sampleLimit, LIGHTHOUSE_SAMPLE_LIMIT)
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
  assert.equal(attempts, 2, "two low samples agree, so no tiebreaker is needed")
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
  assert.equal(
    attempts,
    LIGHTHOUSE_SAMPLE_LIMIT,
    "an unmeasurable performance category keeps asking for a tiebreaker"
  )
  assert.equal(reports._agents[0].categories.accessibility.score, 0.9)
  const evaluation = evaluateLighthouseReports(reports)
  assert.equal(evaluation.failed, true)
  assert.ok(
    evaluation.messages.includes(
      "FAIL https://lyrashieldai.com/agents accessibility: 0.9 (min 0.95)"
    )
  )
  assert.ok(evaluation.messages.includes("ok   https://lyrashieldai.com/agents seo: 1 (min 0.95)"))
  assert.ok(
    evaluation.messages.includes("FAIL https://lyrashieldai.com/agents runtimeError: NO_NAVSTART")
  )
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
    LIGHTHOUSE_PAGES.flatMap((page) => {
      const url = new URL(page.path, origin).toString()
      return [url, url]
    })
  )
  assert.equal(Object.keys(reports).length, LIGHTHOUSE_PAGES.length)
  assert.equal(reports._agents[0].categories.accessibility.score, 1)
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

test("retries a thrown NO_NAVSTART instrumentation failure only once per sample", async (t) => {
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
  assert.equal(attempts, 3, "one retry in sample 1, then one attempt for sample 2")
  assert.equal(reports._agents[0].categories.performance.score, 0.79)
  assert.equal(evaluateLighthouseReports(reports).failed, true)
  assert.match(
    readFileSync(
      path.join(
        reportsDir,
        "attempts",
        "lyrashield-lighthouse_agents.sample-1.attempt-1.diagnostic.txt"
      ),
      "utf8"
    ),
    /NO_NAVSTART/
  )
  const secondMetadata = JSON.parse(
    readFileSync(
      path.join(
        reportsDir,
        "attempts",
        "lyrashield-lighthouse_agents.sample-1.attempt-2.metadata.json"
      ),
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
  assert.deepEqual(invocations, [
    "https://lyrashieldai.com/",
    "https://lyrashieldai.com/",
    "https://lyrashieldai.com/pricing",
    "https://lyrashieldai.com/pricing",
    "https://lyrashieldai.com/agents",
    "https://lyrashieldai.com/agents",
    "https://lyrashieldai.com/scan",
    "https://lyrashieldai.com/webmcp",
    "https://lyrashieldai.com/webmcp",
  ])
  assert.equal(Object.keys(reports).length, LIGHTHOUSE_PAGES.length)
  assert.deepEqual(reports._scan, [])
  assert.equal(evaluateLighthouseReports(reports).failed, true)
  assert.ok(
    existsSync(
      path.join(reportsDir, "attempts", "lyrashield-lighthouse_scan.sample-1.attempt-1.json")
    )
  )
  const invalidMetadata = JSON.parse(
    readFileSync(
      path.join(
        reportsDir,
        "attempts",
        "lyrashield-lighthouse_scan.sample-1.attempt-1.metadata.json"
      ),
      "utf8"
    )
  )
  assert.equal(invalidMetadata.reportParsed, false)
  assert.equal(invalidMetadata.reportFile, "lyrashield-lighthouse_scan.sample-1.attempt-1.json")
  assert.match(
    readFileSync(
      path.join(
        reportsDir,
        "attempts",
        "lyrashield-lighthouse_scan.sample-1.attempt-1.diagnostic.txt"
      ),
      "utf8"
    ),
    /invalid report JSON/
  )
})
