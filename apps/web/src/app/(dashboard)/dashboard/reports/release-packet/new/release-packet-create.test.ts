import { describe, expect, it } from "vitest"
import { parseReleasePacketSearchParams } from "./release-packet-create"

describe("release packet creation query", () => {
  it("accepts exactly one full release identity", () => {
    expect(
      parseReleasePacketSearchParams({
        targetId: "target-1",
        commit: "a".repeat(40),
      })
    ).toEqual({
      status: "ready",
      targetId: "target-1",
      identity: { kind: "COMMIT", value: "a".repeat(40) },
    })
  })

  it("rejects missing, ambiguous or abbreviated identities", () => {
    expect(parseReleasePacketSearchParams({ targetId: "target-1" }).status).toBe("invalid")
    expect(
      parseReleasePacketSearchParams({
        targetId: "target-1",
        commit: "a".repeat(40),
        artifactDigest: `sha256:${"b".repeat(64)}`,
      }).status
    ).toBe("invalid")
    expect(parseReleasePacketSearchParams({ targetId: "target-1", commit: "abc1234" }).status).toBe(
      "invalid"
    )
  })
})
