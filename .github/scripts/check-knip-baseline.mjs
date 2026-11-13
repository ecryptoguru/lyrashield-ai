import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import baseline from "../../knip-baseline.json" with { type: "json" }

/** Compare exact file/type/name IDs; source line movement is intentionally irrelevant. */
export function compareKnipReport(report, baseline) {
  const current = new Set()
  for (const issue of report.issues) {
    for (const [type, entries] of Object.entries(issue)) {
      if (type === "file") continue
      for (const entry of entries) {
        if (typeof entry.name !== "string") throw new Error(`Unexpected Knip ${type} entry`)
        current.add(`${issue.file}:${type}:${entry.name}`)
      }
    }
  }
  const reviewed = new Set()
  for (const entry of baseline.issues) {
    if (!entry.reason?.trim() || reviewed.has(entry.id)) {
      throw new Error(`Missing rationale or duplicate baseline ID: ${entry.id}`)
    }
    reviewed.add(entry.id)
  }
  return {
    added: [...current].filter((id) => !reviewed.has(id)).sort(),
    resolved: [...reviewed].filter((id) => !current.has(id)).sort(),
    current: current.size,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const result = spawnSync("pnpm", ["exec", "knip", "--reporter", "json", "--no-progress"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || ![0, 1].includes(result.status)) {
    throw result.error ?? new Error(result.stderr || `Knip exited ${result.status}`)
  }
  const comparison = compareKnipReport(JSON.parse(result.stdout), baseline)
  if (result.stderr) process.stderr.write(result.stderr)
  console.log(
    `Knip: ${comparison.current} findings; ${comparison.added.length} new, ${comparison.resolved.length} resolved.`
  )
  for (const id of comparison.added) console.error(`NEW: ${id}`)
  for (const id of comparison.resolved) console.log(`RESOLVED (remove from baseline): ${id}`)
  if (comparison.added.length) process.exitCode = 1
}
