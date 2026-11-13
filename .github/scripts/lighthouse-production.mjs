import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const LIGHTHOUSE_PAGES = Object.freeze([
  { path: "/", name: "_" },
  { path: "/pricing", name: "_pricing" },
  { path: "/agents", name: "_agents" },
  { path: "/scan", name: "_scan" },
  { path: "/webmcp", name: "_webmcp" },
])

export const LIGHTHOUSE_MINIMUM = Object.freeze({
  performance: 0.8,
  accessibility: 0.95,
  seo: 0.95,
})

/**
 * Score sampling policy.
 *
 * A single Lighthouse sample is not stable: the same page code has measured
 * anywhere from 0.69 to 0.97 performance because total blocking time swings
 * with runner contention, the autoplaying hero video and PostHog. Gating on
 * one sample therefore fails releases at random.
 *
 * The gate now takes at least MIN_SAMPLES and at most LIGHTHOUSE_SAMPLE_LIMIT
 * samples per page and compares the MEDIAN of each category against the
 * unchanged thresholds. The median needs no tiebreaker when two samples agree
 * on pass/fail, because the median of two agreeing samples sits on the same
 * side of the threshold. A third sample is only spent when the first two
 * straddle a threshold, which is the one case where the median of two samples
 * could land on the wrong side of a single flaky reading.
 */
export const LIGHTHOUSE_SAMPLE_LIMIT = 3
const MIN_SAMPLES = 2
const MAX_ATTEMPTS = 2

export function hasNoNavstart(report, diagnostic = "") {
  const runtimeErrorCode = report?.runtimeError?.code
  if (typeof runtimeErrorCode === "string" && runtimeErrorCode.length > 0) {
    return runtimeErrorCode === "NO_NAVSTART"
  }
  return /\bNO_NAVSTART\b/.test(diagnostic)
}

function isValidScore(score) {
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1
}

function hasValidPerformanceScore(report) {
  return isValidScore(report?.categories?.performance?.score)
}

export function median(values) {
  const sorted = values.filter(isValidScore).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

export function shouldRetryNoNavstart({
  report,
  diagnostic = "",
  attempt,
  maxAttempts = MAX_ATTEMPTS,
}) {
  return (
    attempt < maxAttempts &&
    hasNoNavstart(report, diagnostic) &&
    !hasValidPerformanceScore(report)
  )
}

function samplesFromEntry(entry) {
  if (Array.isArray(entry)) return entry.filter(Boolean)
  return entry ? [entry] : []
}

/**
 * How many samples this page still needs. Returns the count already collected
 * when two samples agree on pass/fail for every category, and one more when
 * the collected samples straddle any threshold.
 */
export function neededSampleCount(samples, minimum = LIGHTHOUSE_MINIMUM) {
  if (samples.length >= LIGHTHOUSE_SAMPLE_LIMIT) return samples.length
  if (samples.length < MIN_SAMPLES) return MIN_SAMPLES
  const straddles = Object.keys(minimum).some((category) => {
    const values = samples.map((sample) => sample?.categories?.[category]?.score)
    if (values.some((value) => !isValidScore(value))) return true
    return Math.min(...values) < minimum[category] && Math.max(...values) >= minimum[category]
  })
  return straddles ? samples.length + 1 : samples.length
}

function formatScore(score) {
  return isValidScore(score) ? String(score) : "missing"
}

export function evaluateLighthouseReports(reports, origin = "https://lyrashieldai.com") {
  let failed = false
  const rows = [
    "| Page | samples | performance (median) | accessibility (median) | seo (median) |",
    "| --- | --- | --- | --- | --- |",
  ]
  const messages = []
  const collectionMessages = []
  const runtimeMessages = []

  for (const page of LIGHTHOUSE_PAGES) {
    const samples = samplesFromEntry(reports[page.name])
    const collectedSamples = samples.filter((sample) => !sample?.collectionFailure)
    const first = samples[0]
    const url = first?.finalDisplayedUrl || first?.finalUrl || new URL(page.path, origin).toString()

    const requiredSamples = neededSampleCount(collectedSamples)
    if (collectedSamples.length < requiredSamples) {
      collectionMessages.push(
        "FAIL " +
          url +
          " collection: collected " +
          collectedSamples.length +
          " of " +
          requiredSamples +
          " required samples"
      )
      failed = true
    }

    for (const [index, sample] of samples.entries()) {
      const detail = Object.keys(LIGHTHOUSE_MINIMUM)
        .map((category) => category + ": " + formatScore(sample?.categories?.[category]?.score))
        .join(" ")
      messages.push("sample " + (index + 1) + "/" + samples.length + " " + url + " " + detail)

      if (sample?.collectionFailure) {
        collectionMessages.push(
          "FAIL " +
            url +
            " collection: sample " +
            (sample.collectionFailure.sample ?? index + 1) +
            " could not be collected"
        )
        failed = true
      }
    }

    for (const sample of samples) {
      if (!sample?.runtimeError) continue
      const code =
        typeof sample.runtimeError.code === "string" && sample.runtimeError.code.length > 0
          ? sample.runtimeError.code
          : "unknown"
      const message =
        typeof sample.runtimeError.message === "string" ? sample.runtimeError.message : ""
      runtimeMessages.push(
        "FAIL " + url + " runtimeError: " + code + (message ? ": " + message : "")
      )
      failed = true
    }

    const cells = []
    for (const [category, threshold] of Object.entries(LIGHTHOUSE_MINIMUM)) {
      const values = collectedSamples.map((sample) => sample?.categories?.[category]?.score)
      const medianScore = median(values)
      const complete = values.length > 0 && values.every(isValidScore)
      const line =
        url + " " + category + ": " + formatScore(medianScore) + " (min " + threshold + ")"
      if (!complete || medianScore === null || medianScore < threshold) {
        messages.push("FAIL " + line)
        cells.push("**" + formatScore(medianScore) + "**")
        failed = true
      } else {
        messages.push("ok   " + line)
        cells.push(String(medianScore))
      }
    }

    rows.push("| " + url + " | " + collectedSamples.length + " | " + cells.join(" | ") + " |")
  }

  return {
    failed,
    messages: [...messages, ...collectionMessages, ...runtimeMessages],
    summary:
      "## Lighthouse production scores\n\n" +
      rows.join("\n") +
      "\n" +
      [...collectionMessages, ...runtimeMessages].join("\n") +
      (collectionMessages.length + runtimeMessages.length > 0 ? "\n" : ""),
  }
}

function readReport(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

export function runLighthouseAttempt(url, outputPath) {
  const result = spawnSync(
    "npx",
    [
      "--yes",
      "lighthouse@13.0.1",
      url,
      "--chrome-flags=--headless --no-sandbox --disable-dev-shm-usage",
      "--only-categories=performance,accessibility,seo",
      "--output=json",
      "--output-path=" + outputPath,
      "--quiet",
    ],
    { encoding: "utf8" }
  )
  const diagnostic = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .join("\n")
  return {
    report: readReport(outputPath),
    diagnostic,
    exitCode: result.status ?? 1,
  }
}

function sampleScoreRecord(samples) {
  return Object.fromEntries(
    Object.keys(LIGHTHOUSE_MINIMUM).map((category) => [
      category,
      {
        samples: samples.map((sample) => sample?.categories?.[category]?.score ?? null),
        median: median(samples.map((sample) => sample?.categories?.[category]?.score)),
      },
    ])
  )
}

export async function collectLighthouseReports({
  origin = "https://lyrashieldai.com",
  reportsDir,
  pages = LIGHTHOUSE_PAGES,
  invoke = runLighthouseAttempt,
  logger = console,
  sampleLimit = LIGHTHOUSE_SAMPLE_LIMIT,
}) {
  mkdirSync(reportsDir, { recursive: true })
  const attemptsDir = path.join(reportsDir, "attempts")
  mkdirSync(attemptsDir, { recursive: true })
  const reports = {}

  for (const page of pages) {
    const url = new URL(page.path, origin).toString()
    const finalPath = path.join(reportsDir, "lyrashield-lighthouse" + page.name + ".json")
    const samplesPath = path.join(reportsDir, "lyrashield-lighthouse" + page.name + ".samples.json")
    const samples = []
    let lastDiagnostic = ""
    let lastExitCode = 1
    let sample = 0
    let target = Math.min(MIN_SAMPLES, sampleLimit)

    while (sample < target) {
      sample += 1
      const stem = "lyrashield-lighthouse" + page.name + ".sample-" + sample
      const samplePath = path.join(attemptsDir, stem + ".json")
      rmSync(samplePath, { force: true })
      let lastReport = null
      let lastAttemptPath = null

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const attemptStem = stem + ".attempt-" + attempt
        const attemptPath = path.join(attemptsDir, attemptStem + ".json")
        lastAttemptPath = attemptPath
        const diagnosticPath = path.join(attemptsDir, attemptStem + ".diagnostic.txt")
        const metadataPath = path.join(attemptsDir, attemptStem + ".metadata.json")
        rmSync(attemptPath, { force: true })
        rmSync(diagnosticPath, { force: true })
        rmSync(metadataPath, { force: true })

        let result
        try {
          result = await invoke(url, attemptPath)
        } catch (error) {
          result = {
            report: null,
            diagnostic: error instanceof Error ? error.stack || error.message : String(error),
            exitCode: 1,
          }
        }

        const report = result?.report ?? readReport(attemptPath)
        const diagnostic = typeof result?.diagnostic === "string" ? result.diagnostic : ""
        const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : 1
        lastReport = report
        lastDiagnostic = diagnostic
        lastExitCode = exitCode

        if (report && !existsSync(attemptPath)) {
          writeFileSync(attemptPath, JSON.stringify(report, null, 2) + "\n")
        }

        writeFileSync(diagnosticPath, diagnostic || "(no CLI diagnostic output)\n")
        writeFileSync(
          metadataPath,
          JSON.stringify(
            {
              path: page.path,
              url,
              sample,
              attempt,
              maxAttempts: MAX_ATTEMPTS,
              sampleLimit,
              exitCode,
              reportParsed: Boolean(report),
              reportFile: existsSync(attemptPath) ? path.basename(attemptPath) : null,
              diagnosticFile: path.basename(diagnosticPath),
            },
            null,
            2
          ) + "\n"
        )

        if (exitCode !== 0) {
          logger.warn(
            "Lighthouse invocation for " +
              page.path +
              " (sample " +
              sample +
              ") exited " +
              exitCode +
              (diagnostic ? ": " + diagnostic.slice(0, 500) : "")
          )
        }

        if (shouldRetryNoNavstart({ report, diagnostic, attempt })) {
          logger.warn(
            "Lighthouse returned NO_NAVSTART for " +
              page.path +
              " on sample " +
              sample +
              " attempt " +
              attempt +
              "; retrying once."
          )
          continue
        }

        break
      }

      if (lastReport) {
        if (lastExitCode !== 0) {
          lastReport.collectionFailure = {
            code: hasNoNavstart(lastReport, lastDiagnostic) ? "NO_NAVSTART" : "NONZERO_EXIT",
            sample,
            exitCode: lastExitCode,
            diagnostic: lastDiagnostic,
          }
        }
        writeFileSync(samplePath, JSON.stringify(lastReport, null, 2) + "\n")
        samples.push(lastReport)
      } else {
        logger.warn(
          "Lighthouse produced no JSON report for " +
            page.path +
            " (sample " +
            sample +
            ")" +
            (lastDiagnostic ? ": " + lastDiagnostic.slice(0, 500) : "")
        )
        const collectionFailure = {
          code: hasNoNavstart(null, lastDiagnostic)
            ? "NO_NAVSTART"
            : lastAttemptPath && existsSync(lastAttemptPath)
              ? "INVALID_REPORT"
              : "NO_REPORT",
          sample,
          exitCode: lastExitCode,
          diagnostic: lastDiagnostic,
        }
        const failedSample = { finalUrl: url, categories: {}, collectionFailure }
        writeFileSync(samplePath, JSON.stringify(failedSample, null, 2) + "\n")
        samples.push(failedSample)
        break
      }

      if (lastReport.collectionFailure) break

      target = Math.min(neededSampleCount(samples), sampleLimit)
    }

    const successfulSamples = samples.filter((entry) => !entry?.collectionFailure)
    if (successfulSamples.length > 0) {
      const representative =
        successfulSamples.find((entry) => entry && !entry.runtimeError) ?? successfulSamples[0]
      writeFileSync(finalPath, JSON.stringify(representative, null, 2) + "\n")
    } else {
      rmSync(finalPath, { force: true })
    }
    reports[page.name] = samples

    writeFileSync(
      samplesPath,
      JSON.stringify(
        {
          url,
          sampleLimit,
          sampled: successfulSamples.length,
          attempted: samples.length,
          collectionFailures: samples
            .filter((entry) => entry?.collectionFailure)
            .map((entry) => entry.collectionFailure),
          categories: sampleScoreRecord(successfulSamples),
        },
        null,
        2
      ) + "\n"
    )
  }

  return reports
}

export async function main(reportsDir = "lighthouse-reports") {
  const reports = await collectLighthouseReports({ reportsDir })
  const evaluation = evaluateLighthouseReports(reports)
  for (const message of evaluation.messages) {
    if (message.startsWith("FAIL ")) console.error(message)
    else console.log(message)
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, evaluation.summary)
  }
  if (evaluation.failed) process.exitCode = 1
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
