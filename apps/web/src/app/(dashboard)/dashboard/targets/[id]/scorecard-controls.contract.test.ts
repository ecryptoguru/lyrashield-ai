import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// apps/web has no component test harness; preserve the inline confirmation contract here.
const source = readFileSync(new URL("./scorecard-controls.tsx", import.meta.url), "utf8")

describe("scorecard confirmation", () => {
  it("uses honest inline semantics and restores focus to its trigger", () => {
    expect(source).toContain('role="group"')
    expect(source).not.toContain('aria-modal="true"')
    expect(source).not.toContain('role="alertdialog"')
    expect(source).toContain("requestAnimationFrame(() => confirmationTriggerRef.current?.focus())")
    expect(source).toContain("onClick={closeConfirmation}")
    expect(source).toContain("ref={noticeRef}")
    expect(source).toContain('role="status" tabIndex={-1}')
  })

  it("labels only observed sharing counts and explains referral qualification", () => {
    expect(source).toContain('"Scorecard visits"')
    expect(source).toContain('"Share actions"')
    expect(source).toContain('"Attributed signups"')
    expect(source).not.toContain('"Human views"')
    expect(source).toContain('import { SCORECARD_REFERRAL_BONUS_MINUTES } from "@lyrashield/types"')
    expect(source).toContain("first real scan")
    expect(source).toContain("pending until then")
    expect(source).toContain("include pending and credited referrals")
    expect(source.replace(/\s+/g, " ")).toContain(
      "External posts and impressions are not measured."
    )
  })

  it("keeps publication and revocation behind explicit user actions", () => {
    expect(source).toContain("Create public scorecard")
    expect(source).toContain("Revoke public scorecard")
    expect(source).toContain("onClick={() => void create()}")
    expect(source).toContain("onClick={() => void revoke()}")
    expect(source).toContain('method: "POST"')
    expect(source).toContain('method: "DELETE"')
  })
})
