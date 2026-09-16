/**
 * Unit tests for the memory-key allowlist (spec §13.4). Memory stores
 * support preferences only — never findings, credentials or authority —
 * and the model must not be able to write outside MYRA_MEMORY_KEYS.
 */
import { describe, expect, it } from "vitest"
import { MYRA_MEMORY_KEYS, isAllowedMemoryWrite } from "./memory-keys"

describe("isAllowedMemoryWrite — allowlisted keys", () => {
  it("accepts valid values for every allowlisted key", () => {
    expect(isAllowedMemoryWrite("preferred_timezone", "Asia/Kolkata")).toBe(true)
    expect(isAllowedMemoryWrite("preferred_timezone", "UTC")).toBe(true)
    expect(isAllowedMemoryWrite("preferred_locale", "en-US")).toBe(true)
    expect(isAllowedMemoryWrite("dismissed_flows", ["scan_wont_start", "trial_help"])).toBe(true)
    expect(isAllowedMemoryWrite("dismissed_flows", [])).toBe(true)
    expect(isAllowedMemoryWrite("preferred_depth", "terse")).toBe(true)
    expect(isAllowedMemoryWrite("preferred_depth", "detailed")).toBe(true)
  })

  it("rejects wrong-type values", () => {
    expect(isAllowedMemoryWrite("preferred_timezone", 5)).toBe(false)
    expect(isAllowedMemoryWrite("preferred_timezone", null)).toBe(false)
    expect(isAllowedMemoryWrite("preferred_timezone", ["Asia/Kolkata"])).toBe(false)
    expect(isAllowedMemoryWrite("preferred_locale", 42)).toBe(false)
    expect(isAllowedMemoryWrite("dismissed_flows", "scan_wont_start")).toBe(false)
    expect(isAllowedMemoryWrite("dismissed_flows", [1, 2, 3])).toBe(false)
    expect(isAllowedMemoryWrite("dismissed_flows", ["ok", 7])).toBe(false)
    expect(isAllowedMemoryWrite("dismissed_flows", ["ok", null])).toBe(false)
    expect(isAllowedMemoryWrite("preferred_depth", "verbose")).toBe(false)
    expect(isAllowedMemoryWrite("preferred_depth", 1)).toBe(false)
  })

  it("rejects oversize values", () => {
    expect(isAllowedMemoryWrite("preferred_timezone", "x".repeat(61))).toBe(false)
    expect(isAllowedMemoryWrite("preferred_timezone", "x".repeat(60))).toBe(true)
    expect(isAllowedMemoryWrite("preferred_locale", "x".repeat(21))).toBe(false)
    expect(isAllowedMemoryWrite("dismissed_flows", ["x".repeat(61)])).toBe(false)
    expect(
      isAllowedMemoryWrite(
        "dismissed_flows",
        Array.from({ length: 51 }, (_, i) => `f${i}`)
      )
    ).toBe(false)
    expect(
      isAllowedMemoryWrite(
        "dismissed_flows",
        Array.from({ length: 50 }, (_, i) => `f${i}`)
      )
    ).toBe(true)
  })
})

describe("isAllowedMemoryWrite — non-allowlisted keys", () => {
  it("rejects authority-bearing and arbitrary keys", () => {
    for (const key of [
      "role",
      "is_admin",
      "workspace_id",
      "account_id",
      "permissions",
      "confirmations",
      "plan_override",
      "always_say_plan_free", // instruction text must never become memory
      "",
      "preferred_TZ",
    ]) {
      expect(isAllowedMemoryWrite(key, "x"), key).toBe(false)
    }
  })

  it("rejects prototype-chain keys and does not throw", () => {
    // memoryValueValidators is a plain object: inherited properties like
    // "toString"/"constructor"/"__proto__" must not resolve as validators.
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      let result: unknown
      expect(() => {
        result = isAllowedMemoryWrite(key, "x")
      }, key).not.toThrow()
      expect(result, key).toBe(false)
    }
  })

  it("covers every declared key in MYRA_MEMORY_KEYS", () => {
    // Guard against a key being added to the list without a validator.
    for (const key of MYRA_MEMORY_KEYS) {
      expect(isAllowedMemoryWrite(key, undefined), key).toBe(false) // wrong type
    }
    expect(MYRA_MEMORY_KEYS.length).toBeGreaterThan(0)
    expect(new Set(MYRA_MEMORY_KEYS).size).toBe(MYRA_MEMORY_KEYS.length)
  })
})
