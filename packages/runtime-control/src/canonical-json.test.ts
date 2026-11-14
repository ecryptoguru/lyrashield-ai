import { describe, expect, it } from "vitest"
import { canonicalJson } from "./canonical-json"

describe("canonical JSON", () => {
  it("retains own prototype-named properties at every depth", () => {
    const value: unknown = JSON.parse('{"outer":{"__proto__":{"forged":true},"a":1}}')
    expect(canonicalJson(value)).toBe('{"outer":{"__proto__":{"forged":true},"a":1}}')
    expect(canonicalJson(value)).not.toBe(canonicalJson({ outer: { a: 1 } }))
  })
})
