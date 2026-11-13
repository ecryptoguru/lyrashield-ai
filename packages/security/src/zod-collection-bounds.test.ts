import { describe, expect, it } from "vitest"
import { z } from "zod"

describe("validation collection resource bounds", () => {
  it("rejects an oversized array before parsing its elements", () => {
    let parsed = 0
    const element = z.string().transform((value) => {
      parsed++
      return value
    })
    expect(z.array(element).max(1).safeParse(["a", "b"]).success).toBe(false)
    expect(parsed).toBe(0)
  })

  it("rejects an oversized set before parsing its elements", () => {
    let parsed = 0
    const element = z.string().transform((value) => {
      parsed++
      return value
    })
    expect(
      z
        .set(element)
        .max(1)
        .safeParse(new Set(["a", "b"])).success
    ).toBe(false)
    expect(parsed).toBe(0)
  })

  it("rejects an oversized map before parsing its keys", () => {
    let parsed = 0
    const key = z.string().transform((value) => {
      parsed++
      return value
    })
    expect(
      z
        .map(key, z.string())
        .max(1)
        .safeParse(
          new Map([
            ["a", "1"],
            ["b", "2"],
          ])
        ).success
    ).toBe(false)
    expect(parsed).toBe(0)
  })
})
