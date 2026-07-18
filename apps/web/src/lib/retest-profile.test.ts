import { describe, expect, it } from "vitest"
import { resolveRetestProfile } from "./retest-profile"

describe("resolveRetestProfile", () => {
  it("uses the bounded Safe cap for deterministic scanner findings", () => {
    expect(resolveRetestProfile("DEEP", ["sca"])).toEqual(
      expect.objectContaining({ mode: "SAFE", determinismMode: "targeted_scanner" })
    )
  })

  it("keeps the source depth for engine-only findings", () => {
    expect(resolveRetestProfile("DEEP", ["engine"])).toEqual(
      expect.objectContaining({ mode: "DEEP", determinismMode: "targeted_engine" })
    )
  })

  it("keeps the source depth when a deterministic signal also required engine analysis", () => {
    expect(resolveRetestProfile("DEEP", ["sca", "engine"])).toEqual(
      expect.objectContaining({ mode: "DEEP", determinismMode: "targeted_engine" })
    )
  })
})
