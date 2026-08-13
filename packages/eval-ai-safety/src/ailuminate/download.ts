/**
 * Download script for the MLCommons AILuminate demo prompt set.
 *
 * Usage: npx tsx src/ailuminate/download.ts
 *
 * Downloads the CC-BY-4.0 demo CSV (1,200 prompts) from the official
 * mlcommons/ailuminate GitHub repository and caches it at
 * `data/ailuminate-demo.csv`.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

const DATA_DIR = resolve(process.cwd(), "packages", "eval-ai-safety", "data")
const CSV_PATH = resolve(DATA_DIR, "ailuminate-demo.csv")
const DOWNLOAD_URL =
  "https://raw.githubusercontent.com/mlcommons/ailuminate/main/airr_official_1.0_demo_en_us_prompt_set_release.csv"

/**
 * Download the AILuminate demo CSV from GitHub to the local data directory.
 * Uses the global fetch API (Node >= 18).
 */
export async function downloadDemoSet(): Promise<void> {
  if (existsSync(CSV_PATH)) {
    console.log(`AILuminate demo CSV already exists at ${CSV_PATH}`)
    console.log("Delete it to re-download.")
    return
  }

  console.log(`Downloading AILuminate demo prompt set from GitHub…`)
  console.log(`URL: ${DOWNLOAD_URL}`)

  const response = await fetch(DOWNLOAD_URL)
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`)
  }

  const content = await response.text()
  const lineCount = content.split("\n").filter((l: string) => l.trim().length > 0).length - 1

  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(CSV_PATH, content, "utf-8")

  console.log(`Downloaded ${lineCount} prompts to ${CSV_PATH}`)
  console.log(`License: CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/)`)
  console.log(`Source: https://github.com/mlcommons/ailuminate`)
}

// Run when invoked directly via tsx
if (import.meta.url === `file://${process.argv[1]}`) {
  downloadDemoSet().catch((err: unknown) => {
    console.error("Download failed:", err)
    process.exit(1)
  })
}
