import { describe, expect, it } from "vitest"
import { canPurchaseMinutePack } from "./minute-pack-purchase"

describe("canPurchaseMinutePack", () => {
  it.each([
    ["blocks an expired FREE buyer", "FREE", true, false],
    ["allows FREE without a trial", "FREE", false, true],
    ["allows an active FREE trial", "FREE", false, true],
    ["allows paid plans with an old expired trial", "PRO", true, true],
    ["blocks an expired FREE buyer after a paid term ends", "FREE", true, false],
  ])("%s", (_label, effectivePlan, isExpired, expected) => {
    expect(canPurchaseMinutePack({ effectivePlan, trialState: { isExpired } })).toBe(expected)
  })
})
