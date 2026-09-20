/**
 * Scan-quality eval runner — deterministic, offline.
 *
 * Loads stored-evidence fixtures from `cases/` (each JSON is what the app
 * persists for one scan: status/mode, coverage receipts, finding
 * verification tiers, manifest checksum, ingestion warnings) and recomputes
 * the app-side quality surface via `buildScanQualitySurface`. Assertions are
 * exact-value dotted paths into the surface — measured facts and labeled
 * heuristics alike — plus a determinism check: each case is built twice and
 * the two surfaceChecksums must be identical.
 *
 * Nothing here calls a model, a database, or the network; every reported
 * number derives from the fixture's stored evidence only.
 *
 *   ./packages/db/node_modules/.bin/tsx evals/scan-quality/run.ts
 *   ./packages/db/node_modules/.bin/tsx evals/scan-quality/run.ts --case=completed-standard
 *
 * Exit 1 on any failed/invalid case; `last-report.json` is always written.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SCAN_QUALITY_SURFACE_VERSION } from "../../packages/types/src/scan-quality"
import { CASE_DIR, CORPUS_VERSION, runCase, validateCase, type CaseResult } from "./lib"

const REPORT_PATH = join(CASE_DIR, "..", "last-report.json")

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const only = args
    .find((a) => a.startsWith("--case="))
    ?.slice(7)
    ?.split(",")

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- CASE_DIR is the fixed corpus dir
  const files = readdirSync(CASE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()

  const results: CaseResult[] = []
  for (const file of files) {
    let raw: unknown
    try {
      // Case filenames come from the on-disk corpus directory listing.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      raw = JSON.parse(readFileSync(join(CASE_DIR, file), "utf8"))
    } catch (err) {
      results.push({
        id: file,
        title: file,
        status: "invalid",
        reasons: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
      })
      continue
    }
    const validated = validateCase(raw, file)
    if (!validated.ok) {
      results.push({ id: file, title: file, status: "invalid", reasons: validated.problems })
      continue
    }
    if (only && !only.includes(validated.value.id)) continue
    results.push(await runCase(validated.value))
  }

  const totals = { pass: 0, fail: 0, invalid: 0 }
  for (const result of results) totals[result.status] += 1

  const idW = Math.max(8, ...results.map((r) => r.id.length))
  console.log(`${"case".padEnd(idW)}  status   reason`)
  for (const result of results) {
    console.log(`${result.id.padEnd(idW)}  ${result.status.padEnd(7)}  ${result.reasons[0] ?? ""}`)
  }
  console.log(`\n${totals.pass} pass · ${totals.fail} fail · ${totals.invalid} invalid`)

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- REPORT_PATH is the fixed harness report
  writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        harness: "evals/scan-quality",
        corpusVersion: CORPUS_VERSION,
        surfaceVersion: SCAN_QUALITY_SURFACE_VERSION,
        totals,
        results,
      },
      null,
      2
    ) + "\n"
  )
  console.log(`report written to ${REPORT_PATH}`)

  return totals.fail + totals.invalid > 0 ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[scan-quality-eval] runner crashed:", err)
    process.exit(1)
  }
)
