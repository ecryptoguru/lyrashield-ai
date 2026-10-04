import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  copyFileSync,
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

const MAX_ATTEMPTS = 2

export function hasNoNavstart(report, diagnostic = "") {
  if (report?.runtimeError?.code === "NO_NAVSTART") return true
  return /\bNO_NAVSTART\b/.test(diagnostic)
}

function hasValidLighthouseScore(report) {
  if (!report || report.runtimeError) return false
  return Object.keys(LIGHTHOUSE_MINIMUM).some((category) => {
    const score = report.categories?.[category]?.score
    return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1
  })
}

export function shouldRetryNoNavstart({
  report,
  diagnostic = "",
  attempt,
  maxAttempts = MAX_ATTEMPTS,
}) {
  return (
    attempt < maxAttempts && hasNoNavstart(report, diagnostic) && !hasValidLighthouseScore(report)
  )
}

export function evaluateLighthouseReports(reports, origin = "https://lyrashieldai.com") {
  let failed = false
  const rows = ["| Page | performance | accessibility | seo |", "| --- | --- | --- | --- |"]
  const messages = []

  for (const page of LIGHTHOUSE_PAGES) {
    const report = reports[page.name]
    const url =
      report?.finalDisplayedUrl || report?.finalUrl || new URL(page.path, origin).toString()
    const cells = []

    for (const [category, threshold] of Object.entries(LIGHTHOUSE_MINIMUM)) {
      const score = report?.categories?.[category]?.score
      const valid =
        !report?.runtimeError &&
        typeof score === "number" &&
        Number.isFinite(score) &&
        score >= 0 &&
        score <= 1
      const line =
        url + " " + category + ": " + (valid ? score : "missing") + " (min " + threshold + ")"
      if (!valid || score < threshold) {
        messages.push("FAIL " + line)
        cells.push("**" + (valid ? score : "missing") + "**")
        failed = true
      } else {
        messages.push("ok   " + line)
        cells.push(String(score))
      }
    }

    rows.push("| " + url + " | " + cells.join(" | ") + " |")
  }

  return {
    failed,
    messages,
    summary: "## Lighthouse production scores\n\n" + rows.join("\n") + "\n",
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

export async function collectLighthouseReports({
  origin = "https://lyrashieldai.com",
  reportsDir,
  pages = LIGHTHOUSE_PAGES,
  invoke = runLighthouseAttempt,
  logger = console,
}) {
  mkdirSync(reportsDir, { recursive: true })
  const attemptsDir = path.join(reportsDir, "attempts")
  mkdirSync(attemptsDir, { recursive: true })
  const reports = {}

  for (const page of pages) {
    const url = new URL(page.path, origin).toString()
    const finalPath = path.join(reportsDir, "lyrashield-lighthouse" + page.name + ".json")
    let lastReport = null
    let lastDiagnostic = ""

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const attemptStem = "lyrashield-lighthouse" + page.name + ".attempt-" + attempt
      const attemptPath = path.join(attemptsDir, attemptStem + ".json")
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
            attempt,
            maxAttempts: MAX_ATTEMPTS,
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
            " exited " +
            exitCode +
            (diagnostic ? ": " + diagnostic.slice(0, 500) : "")
        )
      }

      if (shouldRetryNoNavstart({ report, diagnostic, attempt })) {
        logger.warn(
          "Lighthouse returned NO_NAVSTART for " +
            page.path +
            " on attempt " +
            attempt +
            "; retrying once."
        )
        continue
      }

      if (report) {
        copyFileSync(attemptPath, finalPath)
        reports[page.name] = report
      } else {
        rmSync(finalPath, { force: true })
        logger.warn("Lighthouse produced no JSON report for " + page.path)
      }
      break
    }

    if (lastReport?.runtimeError?.code === "NO_NAVSTART" && !reports[page.name]) {
      reports[page.name] = lastReport
      const lastAttempt = path.join(
        attemptsDir,
        "lyrashield-lighthouse" + page.name + ".attempt-" + MAX_ATTEMPTS + ".json"
      )
      if (existsSync(lastAttempt)) copyFileSync(lastAttempt, finalPath)
    } else if (!lastReport && lastDiagnostic && !reports[page.name]) {
      logger.warn(
        "Last Lighthouse diagnostic for " + page.path + ": " + lastDiagnostic.slice(0, 500)
      )
    }
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
