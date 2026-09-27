import { describe, expect, it } from "vitest"
import {
  scorecardCaption,
  scorecardChannelUrl,
  scorecardEmbed,
  SCORECARD_FORMAT_DIMENSIONS,
  scorecardFixesSummary,
  scorecardUrlWithSource,
  scorecardTrackingAllowed,
  SCORECARD_CHANNELS,
} from "./scorecard-sharing"

describe("scorecard sharing", () => {
  it("builds scope-qualified copy and encoded channel URLs without sensitive fields", () => {
    const caption = scorecardCaption("A", 3, "fixes")
    expect(caption).toBe("3 findings fixed and retest-confirmed. Current scoped grade: A.")
    expect(scorecardChannelUrl("bluesky", "https://app.test/score/ABC", caption)).toContain(
      encodeURIComponent("source=bluesky")
    )
    expect(scorecardChannelUrl("reddit", "https://app.test/score/ABC", caption)).toContain(
      "reddit.com/submit"
    )
    expect(scorecardUrlWithSource("https://app.test/score/ABC?ref=CODE", "embed")).toBe(
      "https://app.test/score/ABC?ref=CODE&source=embed&utm_source=embed&utm_medium=badge"
    )
    expect(scorecardEmbed("https://app.test/score/ABC", "https://app.test/badge.svg")).toBe(
      "[![Scanned by LyraShield AI](https://app.test/badge.svg)](https://app.test/score/ABC)"
    )
  })

  it("builds every channel URL with the referral and allowlisted source", () => {
    const url = "https://app.test/score/ABC?ref=CODE"
    const caption = scorecardCaption("A", 3, "grade")
    for (const channel of SCORECARD_CHANNELS) {
      if (["native", "copy", "download", "embed"].includes(channel)) {
        const tracked = new URL(scorecardUrlWithSource(url, channel))
        expect(tracked.searchParams.get("ref")).toBe("CODE")
        expect(tracked.searchParams.get("source")).toBe(channel)
        continue
      }
      const channelUrl = scorecardChannelUrl(
        channel as "linkedin" | "x" | "bluesky" | "whatsapp" | "reddit" | "email",
        url,
        caption
      )
      expect(decodeURIComponent(channelUrl)).toContain("ref=CODE")
      expect(decodeURIComponent(channelUrl)).toContain(`source=${channel}`)
    }
  })

  it("removes optional referral and campaign tracking when sharing with analytics off", () => {
    const bare = scorecardUrlWithSource(
      "https://app.test/score/ABC?ref=CODE&utm_campaign=launch&source=reddit",
      "copy",
      false
    )
    expect(bare).toBe("https://app.test/score/ABC")
    expect(
      scorecardChannelUrl("linkedin", "https://app.test/score/ABC?ref=CODE", "Review", false)
    ).toBe(
      "https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fapp.test%2Fscore%2FABC"
    )
    for (const channel of ["linkedin", "x", "bluesky", "whatsapp", "reddit", "email"] as const) {
      const shared = decodeURIComponent(
        scorecardChannelUrl(channel, "https://app.test/score/ABC?ref=CODE", "Scoped review", false)
      )
      expect(shared).not.toContain("ref=CODE")
      expect(shared).not.toContain("utm_")
      expect(shared).not.toContain("source=")
    }
  })

  it("respects browser privacy signals before referral tracking", () => {
    expect(scorecardTrackingAllowed({})).toBe(true)
    expect(scorecardTrackingAllowed({ doNotTrack: "1" })).toBe(false)
    expect(scorecardTrackingAllowed({ doNotTrack: "yes" })).toBe(false)
    expect(scorecardTrackingAllowed({ globalPrivacyControl: true })).toBe(false)
  })

  it("uses matching dimensions for each card format", () => {
    expect(SCORECARD_FORMAT_DIMENSIONS).toEqual({
      wide: { width: 1200, height: 630 },
      square: { width: 1080, height: 1080 },
      portrait: { width: 1080, height: 1350 },
    })
    for (const { width, height } of Object.values(SCORECARD_FORMAT_DIMENSIONS)) {
      expect(width / height).toBeGreaterThan(0)
    }
  })

  it("does not imply fixes when a card has none", () => {
    expect(scorecardFixesSummary(0)).toBe(
      "No findings are marked fixed and retest-confirmed in this scoped review."
    )
    expect(scorecardCaption("A", 0, "grade")).toContain(
      "No findings are marked fixed and retest-confirmed"
    )
    expect(scorecardCaption("A", 0, "fixes")).not.toContain("0 findings fixed")
  })
})
