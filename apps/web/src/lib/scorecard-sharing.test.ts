import { describe, expect, it } from "vitest"
import {
  scorecardCaption,
  scorecardChannelUrl,
  scorecardEmbed,
  scorecardUrlWithSource,
} from "./scorecard-sharing"

describe("scorecard sharing", () => {
  it("builds scope-qualified copy and encoded channel URLs without sensitive fields", () => {
    const caption = scorecardCaption("A", 3, "fixes")
    expect(caption).toBe(
      "3 findings fixed and retest-verified with LyraShield AI. Current scoped grade: A."
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
})
