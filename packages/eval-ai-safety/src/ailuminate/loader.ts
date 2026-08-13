/**
 * MLCommons AILuminate demo prompt set loader.
 *
 * The demo set (1,200 prompts, CC-BY-4.0) is downloaded from
 * https://github.com/mlcommons/ailuminate at eval time and cached locally.
 * We do NOT bundle the prompts in the repository because they contain
 * sensitive content designed to test AI safety boundaries.
 *
 * The download script is `src/ailuminate/download.ts`.
 * The CSV is cached at `data/ailuminate-demo.csv` (gitignored).
 */
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { AiluminatePrompt as _AiluminatePrompt, AiluminateHazard } from "../types.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CSV_PATH = resolve(__dirname, "..", "..", "data", "ailuminate-demo.csv")

const HAZARD_CODES = new Set<AiluminateHazard>([
  "cse",
  "ddh",
  "hat",
  "nhw",
  "shv",
  "ssh",
  "iv",
  "def",
  "ide",
  "ncr",
  "sxc",
  "bck",
])

/**
 * Parse a CSV line that may contain quoted fields with embedded commas,
 * newlines, and escaped double-quotes.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
    } else {
      if (char === '"') {
        inQuotes = true
      } else if (char === ",") {
        fields.push(current)
        current = ""
      } else {
        current += char
      }
    }
  }
  fields.push(current)
  return fields
}

/**
 * Load the AILuminate demo prompt CSV from a local path.
 * Throws if the file does not exist — call `downloadDemoSet()` first.
 */
export function loadDemoSet(csvPath: string = DEFAULT_CSV_PATH): _AiluminatePrompt[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(csvPath)) {
    throw new Error(
      `AILuminate demo CSV not found at ${csvPath}. Run \`pnpm eval:download\` first.`
    )
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const content = readFileSync(csvPath, "utf-8")
  const lines = content.split("\n").filter((l) => l.trim().length > 0)
  if (lines.length < 2) {
    throw new Error(`AILuminate demo CSV has no data rows at ${csvPath}`)
  }

  // Parse header
  const header = parseCsvLine(lines[0]!)
  const colIndex = {
    releasePromptId: header.indexOf("release_prompt_id"),
    promptText: header.indexOf("prompt_text"),
    hazard: header.indexOf("hazard"),
    persona: header.indexOf("persona"),
    locale: header.indexOf("locale"),
    promptHash: header.indexOf("prompt_hash"),
  }

  if (colIndex.promptText === -1 || colIndex.hazard === -1) {
    throw new Error(`AILuminate demo CSV missing required columns at ${csvPath}`)
  }

  const prompts: _AiluminatePrompt[] = []
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]!)
    const hazard = (fields[colIndex.hazard] ?? "").toLowerCase() as AiluminateHazard
    if (!HAZARD_CODES.has(hazard)) continue

    prompts.push({
      releasePromptId: fields[colIndex.releasePromptId] ?? `row_${i}`,
      promptText: fields[colIndex.promptText] ?? "",
      hazard,
      persona: fields[colIndex.persona] ?? "unknown",
      locale: fields[colIndex.locale] ?? "en_US",
      promptHash: fields[colIndex.promptHash] ?? "",
    })
  }

  return prompts
}

/**
 * Get the default CSV cache path.
 */
export function getDefaultCsvPath(): string {
  return DEFAULT_CSV_PATH
}
