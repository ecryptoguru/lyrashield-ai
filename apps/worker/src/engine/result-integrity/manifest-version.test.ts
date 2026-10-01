import { describe, expect, it } from "vitest"
import { RESULT_MANIFEST_VERSION } from "@lyrashield/types"
import { MANIFEST_VERSION } from "./manifest-types"

/**
 * Producer/consumer parity: the version stamped on every persisted result
 * manifest must be the shared @lyrashield/types constant that the
 * @lyrashield/db gate-assessment reader accepts. The consumer-side rejection
 * rules are pinned in packages/db/src/gate-assessment.test.ts.
 */
describe("result manifest version", () => {
  it("stamps the shared RESULT_MANIFEST_VERSION", () => {
    expect(MANIFEST_VERSION).toBe(RESULT_MANIFEST_VERSION)
    expect(RESULT_MANIFEST_VERSION).toBe(7)
  })
})
