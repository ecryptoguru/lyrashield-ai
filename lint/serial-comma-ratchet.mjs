import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const baselinePath = path.join(root, "lint/serial-comma-baseline.json")
const scannedRoots = [
  "apps/marketing/src",
  "apps/marketing/public",
  "docs",
  "packages/security/src",
  "packages/agent-registry/src",
  "packages/agent-plugin/plugin/skills",
  "packages/agent-plugin/plugin/codex-plugin/skills",
  "packages/agent-plugin/src/build.ts",
  "packages/myra/src",
  "packages/pricing/src",
  "packages/agent-rules/src",
  "packages/mcp/src",
  "packages/types/src/openapi",
]
const serialComma = /, +(and|or)\b/
const sentenceBoundary = /[.!?;]\s+/g
const clauseStarter =
  /^(?:and|or)\s+(?:(?:also\s+(?:accept|allow|include|offer|provide|support|use|work)\b)|(?:no\s+generated\b)|(?:the\s+documented\b)|(?:use|edit|include|return|resume|poll)\b|(?:i|we|you|they|he|she|it|there|this|that)\s+(?:am|is|are|was|were|has|have|had|does|do|did|can|could|will|would|should|must|may|might|[a-z]+s)\b|(?:the|a|an|its|their|our|my)\s+[\w'-]+\s+(?:am|is|are|was|were|has|have|had|does|do|did|can|could|will|would|should|must|may|might|[a-z]+s)\b|(?:its|their|our|my)\s+(?:[\w'-]+\s+){1,3}(?:am|is|are|was|were|has|have|had|does|do|did|can|could|will|would|should|must|may|might|[a-z]+s)\b)/i

function fingerprint(line) {
  return createHash("sha256").update(line).digest("hex")
}

export function scanText(source) {
  const hits = new Map()
  for (const line of source.split(/\r?\n/)) {
    const candidates = [...line.matchAll(new RegExp(serialComma.source, "g"))]
    const listFinal = candidates.some((match) => {
      const before = line.slice(0, match.index)
      let clauseStart = 0
      for (const boundary of before.matchAll(sentenceBoundary)) {
        clauseStart = boundary.index + boundary[0].length
      }
      if (!before.slice(clauseStart).includes(",")) return false

      const continuation = `${match[1]} ${line.slice(match.index + match[0].length).trimStart()}`
      return !clauseStarter.test(continuation)
    })
    if (!listFinal) continue
    const hash = fingerprint(line)
    hits.set(hash, (hits.get(hash) ?? 0) + 1)
  }
  return hits
}

export function findCopyRegressions(baseline, current) {
  const regressions = []
  for (const [file, hashes] of Object.entries(current)) {
    const previous = baseline[file]
    if (!previous) {
      regressions.push(`${file}: new serial-comma candidate(s)`)
      continue
    }
    for (const [hash, count] of Object.entries(hashes)) {
      if (count > (previous[hash] ?? 0)) {
        regressions.push(`${file}: new or increased serial-comma candidate ${hash.slice(0, 12)}`)
      }
    }
  }
  return regressions
}

function countCopyCandidates(files) {
  return Object.values(files).reduce(
    (total, hashes) => total + Object.values(hashes).reduce((sum, count) => sum + count, 0),
    0
  )
}

export function findCopyBaselineGrowth(baseline, current) {
  const growth = []
  for (const [file, hashes] of Object.entries(current)) {
    const currentCount = Object.values(hashes).reduce((sum, count) => sum + count, 0)
    const previousCount = Object.values(baseline[file] ?? {}).reduce((sum, count) => sum + count, 0)
    if (currentCount > previousCount) {
      growth.push(`${file}: candidate count grew from ${previousCount} to ${currentCount}`)
    }
  }
  return growth
}

export function validateCopyBaselineRefresh(baseline, current) {
  const issues = findCopyBaselineGrowth(baseline, current)
  const previousCount = countCopyCandidates(baseline)
  const currentCount = countCopyCandidates(current)
  if (currentCount >= previousCount) {
    issues.push(
      `candidate total must shrink from ${previousCount}; current total is ${currentCount}`
    )
  }
  return issues
}

export function findStaleCopyBaseline(baseline, current) {
  const stale = []
  for (const [file, hashes] of Object.entries(baseline)) {
    const currentHashes = current[file]
    if (!currentHashes) {
      stale.push(`${file}: no current candidates; remove this baseline entry`)
      continue
    }
    for (const [hash, count] of Object.entries(hashes)) {
      if (count > (currentHashes[hash] ?? 0)) {
        stale.push(
          `${file}: baseline candidate ${hash.slice(0, 12)} is no longer present; refresh the baseline`
        )
      }
    }
  }
  return stale
}

function trackedFiles() {
  const output = execFileSync("git", [
    "-C",
    root,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...scannedRoots,
  ])
  return output.toString("utf8").split("\0").filter(Boolean).sort()
}

async function scanRepository() {
  const results = {}
  for (const file of trackedFiles()) {
    let source
    try {
      source = await readFile(path.join(root, file), "utf8")
    } catch (error) {
      if (error.code === "ENOENT") continue
      throw error
    }
    const hits = scanText(source)
    if (hits.size) results[file] = Object.fromEntries([...hits].sort())
  }
  return results
}

async function run() {
  const current = await scanRepository()
  if (process.argv.includes("--write-baseline")) {
    try {
      const previous = JSON.parse(await readFile(baselinePath, "utf8"))
      const previousFiles = previous.files ?? {}
      const issues = validateCopyBaselineRefresh(previousFiles, current)
      if (issues.length) {
        for (const issue of issues) console.error(`COPY BASELINE WOULD GROW ${issue}`)
        process.exitCode = 1
        return
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    const baseline = {
      version: 1,
      pattern: ", +(and|or)\\b in list-final contexts; clause-joining commas excluded",
      roots: scannedRoots,
      files: current,
    }
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
    const count = countCopyCandidates(current)
    console.log(
      `Wrote ${count} existing line candidates across ${Object.keys(current).length} files.`
    )
    return
  }

  const baseline = JSON.parse(await readFile(baselinePath, "utf8"))
  if (
    baseline.version !== 1 ||
    JSON.stringify(baseline.roots) !== JSON.stringify(scannedRoots) ||
    !baseline.files
  ) {
    throw new Error(`${path.relative(root, baselinePath)} has an unsupported format`)
  }
  const regressions = findCopyRegressions(baseline.files, current)
  const stale = findStaleCopyBaseline(baseline.files, current)
  if (regressions.length || stale.length) {
    for (const regression of regressions) console.error(`COPY REGRESSION ${regression}`)
    for (const issue of stale) console.error(`COPY BASELINE STALE ${issue}`)
    if (stale.length)
      console.error(
        "After removing candidates, refresh only reduced debt with pnpm lint:copy-comma -- --write-baseline."
      )
    process.exitCode = 1
    return
  }
  const count = Object.values(current).reduce(
    (total, hashes) => total + Object.values(hashes).reduce((sum, n) => sum + n, 0),
    0
  )
  console.log(
    `Copy ratchet passed: ${count} existing list-final candidates across ${Object.keys(current).length} files; no new line candidates.`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await run()
}
