import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const scanPage = readFileSync(new URL("../pages/scan.astro", import.meta.url), "utf8")
// eslint-disable-next-line security/detect-non-literal-fs-filename
const waitlistForm = readFileSync(
  new URL("../components/WaitlistForm.astro", import.meta.url),
  "utf8"
)

describe("Lite Check fallback copy", () => {
  it("never claims pre-launch status and states configuration honestly", () => {
    expect(scanPage.toLowerCase()).not.toContain("pre-launch")
    expect(scanPage).toContain("automated scans are unavailable and scanning is being configured")
  })
})

describe("waitlist success UX", () => {
  it("never surfaces a numbered queue position to users", () => {
    expect(waitlistForm).not.toContain("#${position.position}")
    expect(waitlistForm).not.toContain("on the waitlist")
    expect(waitlistForm).not.toContain('id="waitlist-position"')
    // Internal referral identifiers stay wired for analytics/sharing.
    expect(waitlistForm).toContain("result.referralCode")
    expect(waitlistForm).toContain("waitlist_submit_success")
  })

  it("keeps the scan page free of user-facing waitlist status copy", () => {
    const visibleCopy = scanPage.replace(/data-[a-z-]+="[^"]*"/g, "")
    expect(visibleCopy.toLowerCase()).not.toMatch(/waitlist position|you're #\d+/)
  })
})
