#!/usr/bin/env node
/**
 * CLI runner for the AI safety evaluation harness.
 *
 * Usage:
 *   pnpm eval                    # Run both suites
 *   pnpm eval -- --owasp         # Run OWASP suite only
 *   pnpm eval -- --ailuminate    # Run AILuminate suite only
 *   pnpm eval -- --download      # Download AILuminate demo CSV first
 *   pnpm eval -- --json          # Output JSON instead of Markdown
 *   pnpm eval -- --output PATH   # Write results to a file
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import {
  runOwaspSuite,
  runAiluminateSuite,
  generateMarkdownReport,
  generateJsonReport,
} from "./index.js"
import { downloadDemoSet } from "./ailuminate/download.js"
import { PromptInjectionGuard } from "@lyrashield/mcp"

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const runOwasp = !args.includes("--ailuminate")
  const runAiluminate = !args.includes("--owasp")
  const wantJson = args.includes("--json")
  const wantDownload = args.includes("--download")
  const outputArg = args.find((a) => a.startsWith("--output="))
  const outputPath = outputArg ? outputArg.slice(9) : null
  const status = wantJson ? console.error : console.log
  const guard = new PromptInjectionGuard({ logEvents: !wantJson })

  if (wantDownload) {
    console.log("Downloading AILuminate demo CSV…")
    await downloadDemoSet()
    console.log()
  }

  const results: string[] = []

  if (runOwasp) {
    status("Running OWASP Gen AI Red Teaming suite…")
    const owaspResult = runOwaspSuite(guard)
    status(
      `  Total: ${owaspResult.totals.total}, Blocked: ${owaspResult.totals.blocked}, Sanitized: ${owaspResult.totals.sanitized}, Allowed: ${owaspResult.totals.allowed}`
    )
    status(`  Expected outcomes: ${owaspResult.totals.expectedOutcomeRate?.toFixed(1)}%`)
    status()
    results.push(wantJson ? generateJsonReport(owaspResult) : generateMarkdownReport(owaspResult))
  }

  if (runAiluminate) {
    try {
      status("Running MLCommons AILuminate demo suite…")
      const ailuminateResult = runAiluminateSuite(guard)
      status(
        `  Total: ${ailuminateResult.totals.total}, Blocked: ${ailuminateResult.totals.blocked}, Sanitized: ${ailuminateResult.totals.sanitized}, Allowed: ${ailuminateResult.totals.allowed}`
      )
      status(`  Block rate (observational): ${ailuminateResult.totals.blockRate.toFixed(1)}%`)
      status()
      results.push(
        wantJson ? generateJsonReport(ailuminateResult) : generateMarkdownReport(ailuminateResult)
      )
    } catch (err) {
      console.error(`  Skipped: ${(err as Error).message}`)
      status()
    }
  }

  const output =
    wantJson && results.length > 1 ? `[\n${results.join(",\n")}\n]` : results.join("\n---\n\n")

  if (outputPath) {
    const fullPath = resolve(outputPath)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    mkdirSync(dirname(fullPath), { recursive: true })
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(fullPath, output, "utf-8")
    console.log(`Results written to ${fullPath}`)
  } else {
    console.log(output)
  }
}

main().catch((err) => {
  console.error("Evaluation failed:", err)
  process.exit(1)
})
