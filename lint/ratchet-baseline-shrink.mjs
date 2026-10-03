import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const baselineFiles = ["lint/size-baseline.json", "lint/serial-comma-baseline.json"]

function compareMetrics(previous, current, label, fields) {
  const issues = []
  for (const [key, values] of Object.entries(current)) {
    const prior = previous[key]
    if (!prior) {
      issues.push(`${label}: new baseline entry ${key}`)
      continue
    }
    for (const field of fields) {
      if (values[field] > prior[field]) {
        issues.push(`${label}: ${key} ${field} increased from ${prior[field]} to ${values[field]}`)
      }
    }
  }
  return issues
}

export function checkSizeBaselineShrink(previous, current) {
  const issues = compareMetrics(previous.metrics, current.metrics, "size", [
    "count",
    "totalExcess",
    "maxExcess",
  ])
  if (previous.version !== current.version) issues.push("size: baseline format version changed")
  if (JSON.stringify(previous.limits) !== JSON.stringify(current.limits)) {
    issues.push("size: configured limits changed")
  }
  return issues
}

export function checkCopyBaselineShrink(previous, current) {
  const issues = []
  if (previous.version !== current.version) issues.push("copy: baseline format version changed")
  if (JSON.stringify(previous.roots) !== JSON.stringify(current.roots)) {
    issues.push("copy: scanned roots changed")
  }
  for (const [file, hashes] of Object.entries(current.files)) {
    const previousHashes = previous.files[file]
    if (!previousHashes) {
      issues.push(`copy: new baseline file ${file}`)
      continue
    }
    const previousCount = Object.values(previousHashes).reduce((sum, count) => sum + count, 0)
    const currentCount = Object.values(hashes).reduce((sum, count) => sum + count, 0)
    if (currentCount > previousCount) {
      issues.push(
        `copy: candidate count in ${file} increased from ${previousCount} to ${currentCount}`
      )
    }
  }
  return issues
}

async function readJson(file) {
  return JSON.parse(await readFile(path.join(root, file), "utf8"))
}

async function readBaseJson(baseSha, file) {
  try {
    const raw = execFileSync("git", ["-C", root, "show", `${baseSha}:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return JSON.parse(raw)
  } catch (error) {
    if (error.status === 128) return null
    throw error
  }
}

async function run() {
  const baseSha = process.env.LYRASHIELD_RATCHET_BASE_SHA
  if (!baseSha || /^0+$/.test(baseSha)) {
    console.log("Ratchet baseline monotonicity skipped: no prior base SHA is available.")
    return
  }
  try {
    execFileSync("git", ["-C", root, "cat-file", "-e", `${baseSha}^{commit}`], { stdio: "ignore" })
  } catch {
    execFileSync("git", ["-C", root, "fetch", "--no-tags", "origin", baseSha, "--depth=1"], {
      stdio: "inherit",
    })
  }

  const checks = [checkSizeBaselineShrink, checkCopyBaselineShrink]
  const issues = []
  for (let index = 0; index < baselineFiles.length; index++) {
    const file = baselineFiles[index]
    const [previous, current] = await Promise.all([readBaseJson(baseSha, file), readJson(file)])
    if (!previous) continue
    issues.push(...checks[index](previous, current))
  }
  if (issues.length) {
    for (const issue of issues) console.error(`RATCHET BASELINE GROWTH ${issue}`)
    process.exitCode = 1
    return
  }
  console.log(`Ratchet baselines only shrank relative to ${baseSha}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await run()
}
