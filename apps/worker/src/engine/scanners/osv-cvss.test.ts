import { describe, expect, it } from "vitest"
import { osvCvss } from "./osv-cvss"

describe("OSV CVSS base scoring", () => {
  it.each([
    ["CVSS:3.1/AV:L/AC:H/PR:N/UI:R/S:U/C:N/I:H/A:H", 6.3],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
    ["CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10],
    ["CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:L/I:L/A:N", 3.8],
    ["CVSS:3.1/S:U/C:N/I:N/A:N/AV:N/AC:L/PR:N/UI:N", 0],
  ])("scores the complete base vector %s", (vector, score) => {
    expect(osvCvss([{ type: "CVSS_V3", score: vector }])).toEqual({ score, vector, source: "OSV" })
  })

  it.each([
    "9.8",
    "CVSS:4.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H",
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/AV:L",
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:Z",
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:F",
  ])("does not invent a score for unsupported or malformed data %s", (vector) => {
    expect(osvCvss([{ type: "CVSS_V3", score: vector }])).toBeUndefined()
  })

  it("selects the highest supported advisory score, preserving its vector", () => {
    const vector = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
    expect(
      osvCvss([
        { type: "CVSS_V2", score: vector },
        { type: "CVSS_V3", score: "CVSS:3.1/AV:L/AC:H/PR:N/UI:R/S:U/C:N/I:H/A:H" },
        { type: "CVSS_V3", score: vector },
      ])
    ).toEqual({ score: 9.8, vector, source: "OSV" })
    expect(osvCvss([{ type: "CVSS_V2", score: vector }])).toBeUndefined()
  })
})
