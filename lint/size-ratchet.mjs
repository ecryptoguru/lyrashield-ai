import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ESLint } from "eslint"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const baselinePath = path.join(root, "lint/size-baseline.json")
const sizeRuleLimits = { "max-lines": 600, "max-lines-per-function": 150 }
const sizeRules = new Set(Object.keys(sizeRuleLimits))

function relativePath(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/")
}

export function collectSizeDebt(results) {
  const metrics = {}
  const errors = []

  for (const result of results) {
    const file = relativePath(result.filePath)
    if (result.errorCount > 0) {
      errors.push(`${file}: ESLint reported ${result.errorCount} error(s)`)
    }
    for (const message of result.messages) {
      if (!sizeRules.has(message.ruleId)) {
        errors.push(
          `${file}:${message.line ?? 1}: unexpected size-lint diagnostic: ${message.message}`
        )
        continue
      }
      const match = message.message.match(/too many lines \((\d+)\)\. Maximum allowed is (\d+)\./)
      if (!match) {
        errors.push(
          `${file}:${message.line ?? 1}: could not measure size warning: ${message.message}`
        )
        continue
      }
      const actual = Number(match[1])
      const limit = Number(match[2])
      if (limit !== sizeRuleLimits[message.ruleId]) {
        errors.push(
          `${file}:${message.line ?? 1}: ${message.ruleId} limit changed from ${sizeRuleLimits[message.ruleId]} to ${limit}`
        )
        continue
      }
      const key = `${file}|${message.ruleId}`
      const metric = (metrics[key] ??= { count: 0, totalExcess: 0, maxExcess: 0 })
      const excess = actual - limit
      metric.count++
      metric.totalExcess += excess
      metric.maxExcess = Math.max(metric.maxExcess, excess)
    }
  }

  return { metrics, errors }
}

export function findSizeRegressions(baselineMetrics, currentMetrics) {
  const regressions = []
  for (const [key, current] of Object.entries(currentMetrics)) {
    const baseline = baselineMetrics[key]
    if (!baseline) {
      regressions.push(`${key}: new oversized file or function set (${current.count} warning(s))`)
      continue
    }
    for (const field of ["count", "totalExcess", "maxExcess"]) {
      if (current[field] > baseline[field]) {
        regressions.push(`${key}: ${field} increased from ${baseline[field]} to ${current[field]}`)
      }
    }
  }
  return regressions
}

export function findStaleSizeBaseline(baselineMetrics, currentMetrics) {
  const stale = []
  for (const [key, baseline] of Object.entries(baselineMetrics)) {
    const current = currentMetrics[key]
    if (!current) {
      stale.push(`${key}: no current size debt; remove this baseline entry`)
      continue
    }
    for (const field of ["count", "totalExcess", "maxExcess"]) {
      if (baseline[field] > current[field]) {
        stale.push(
          `${key}: baseline ${field} ${baseline[field]} exceeds current ${current[field]}; refresh the baseline`
        )
      }
    }
  }
  return stale
}

async function run() {
  process.chdir(root)
  const eslint = new ESLint({ overrideConfigFile: "eslint.size.config.mjs" })
  const results = await eslint.lintFiles([
    "apps/**/src/**/*.{ts,tsx,mts,cts}",
    "packages/**/src/**/*.{ts,tsx,mts,cts}",
  ])
  const { metrics, errors } = collectSizeDebt(results)
  if (errors.length) {
    for (const error of errors) console.error(`ERROR ${error}`)
    process.exitCode = 1
    return
  }

  if (process.argv.includes("--write-baseline")) {
    try {
      const previous = JSON.parse(await readFile(baselinePath, "utf8"))
      const regressions = findSizeRegressions(previous.metrics ?? {}, metrics)
      if (regressions.length) {
        for (const regression of regressions)
          console.error(`SIZE BASELINE WOULD GROW ${regression}`)
        process.exitCode = 1
        return
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    const baseline = {
      version: 1,
      limits: sizeRuleLimits,
      metrics: Object.fromEntries(Object.entries(metrics).sort()),
    }
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(
      `Wrote ${Object.keys(metrics).length} existing size-debt groups to ${relativePath(baselinePath)}`
    )
    return
  }

  let baseline
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8"))
  } catch (error) {
    console.error(`Could not read ${relativePath(baselinePath)}: ${error.message}`)
    process.exitCode = 1
    return
  }
  if (
    baseline.version !== 1 ||
    JSON.stringify(baseline.limits) !== JSON.stringify(sizeRuleLimits) ||
    !baseline.metrics ||
    typeof baseline.metrics !== "object"
  ) {
    console.error(`${relativePath(baselinePath)} has an unsupported format`)
    process.exitCode = 1
    return
  }

  const regressions = findSizeRegressions(baseline.metrics, metrics)
  const stale = findStaleSizeBaseline(baseline.metrics, metrics)
  if (regressions.length || stale.length) {
    for (const regression of regressions) console.error(`SIZE REGRESSION ${regression}`)
    for (const issue of stale) console.error(`SIZE BASELINE STALE ${issue}`)
    if (stale.length)
      console.error(
        "After a shrink, refresh only reduced debt with pnpm lint:size -- --write-baseline."
      )
    process.exitCode = 1
    return
  }
  const warnings = Object.values(metrics).reduce((total, metric) => total + metric.count, 0)
  console.log(
    `Size ratchet passed: ${warnings} existing warnings across ${Object.keys(metrics).length} file/rule groups; no group grew.`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await run()
}
