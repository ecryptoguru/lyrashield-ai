import { describe, expect, it } from "vitest"
import {
  scorecardCaption,
  scorecardChannelUrl,
  scorecardEmbed,
  scorecardTrackingAllowed,
  scorecardUrlWithSource,
  SCORECARD_CHANNELS,
} from "./scorecard-sharing"

describe("scorecard sharing", () => {
  it("builds scope-qualified copy and encoded channel URLs without sensitive fields", () => {
    const caption = scorecardCaption("A", 3, "fixes")
    expect(caption).toBe(
      "3 findings fixed and retest-confirmed with LyraShield AI. Current scoped grade: A."
    )
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

  it("suppresses tracking for DNT or GPC", () => {
    expect(scorecardTrackingAllowed({})).toBe(true)
    expect(scorecardTrackingAllowed({ doNotTrack: "1" })).toBe(false)
    expect(scorecardTrackingAllowed({ doNotTrack: "yes" })).toBe(false)
    expect(scorecardTrackingAllowed({ globalPrivacyControl: true })).toBe(false)
  })
})
