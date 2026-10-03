import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { MYRA_LIMITS } from "@lyrashield/myra"
import { myraRetentionSummary } from "../lib/privacy-retention"

describe("published Myra retention wording", () => {
  it("matches the retention periods enforced by the scheduled job", () => {
    const summary = myraRetentionSummary()
    const privacyPage = readFileSync(new URL("../pages/privacy.astro", import.meta.url), "utf8")

    expect(privacyPage).toContain("myraRetentionSummary()")
    expect(summary).toContain(`${MYRA_LIMITS.conversationRetentionDays} days`)
    expect(summary).toContain(`${MYRA_LIMITS.caseRetentionDays} days after case creation`)
    expect(summary).toContain(`${MYRA_LIMITS.bookingRetentionDays} days after creation`)
    expect(summary).toContain("Canceled bookings with an outstanding calendar-event cancellation")
    expect(summary).toContain(`${MYRA_LIMITS.auditRetentionDays} days after creation`)
    expect(summary).toContain("removed by the scheduled retention job")
  })
})
