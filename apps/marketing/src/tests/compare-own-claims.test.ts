import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The compare pages are public marketing copy. Two classes of LyraShield claim
 * were removed on 2026-10-04 because the code does not support them:
 *
 *  - an "independently verified" finding state and "verification receipts":
 *    no code path writes FindingVerificationStatus.VERIFIED. Ingest writes
 *    DETECTED or INCONCLUSIVE (apps/worker/src/engine/finding-persister.ts:254)
 *    and a deterministic retest writes VALIDATED or INCONCLUSIVE
 *    (apps/worker/src/engine/result-integrity/retest-completion.ts:173-179).
 *  - "immutable" reports: no database or code enforcement makes a report
 *    immutable; reports are checksum-bound snapshots
 *    (packages/db/src/report-service.ts:214-223).
 *
 * This guards the copy against those claims coming back.
 */
const COMPARE_DIR = join(import.meta.dirname, "../content/compare")

const REGRESSED_PHRASES: Array<[string, RegExp]> = [
  ["independently verified state", /independently\s+verified/i],
  ["verification receipt", /verification\s+receipts?/i],
  ["immutable report or snapshot", /\bimmutable\b/i],
  ["separate receipt", /separate\s+receipt/i],
  ["language-agnostic", /language-agnostic/i],
  ["MCP config scanning", /MCP\s+configs/i],
  ["fix PR execution disabled", /Fix PR execution is not enabled/i],
  ["works with any Git repo", /works with any Git repo/i],
  ["adoption claim", /\b(many|most|some)\s+teams\b/i],
]

const pages = readdirSync(COMPARE_DIR).filter((name) => name.endsWith(".md"))

describe("compare page LyraShield claims", () => {
  it("covers all 13 compare pages", () => {
    expect(pages).toHaveLength(13)
  })

  it.each(pages)("%s makes no claim the code does not support", (name) => {
    const body = readFileSync(join(COMPARE_DIR, name), "utf8")
    const hits = REGRESSED_PHRASES.filter(([, pattern]) => pattern.test(body)).map(
      ([label]) => label
    )
    expect(hits).toEqual([])
  })
})
