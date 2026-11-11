import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RelayOwnerRevocations } from "./relay-owner-revocations"

describe("missing-state owner revocations", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }))
  afterEach(() => vi.useRealTimers())

  it("reclaims expired slots before imposing an overflow hold", () => {
    const revocations = new RelayOwnerRevocations(1)
    revocations.revoke("old", "a", 10)
    vi.setSystemTime(10)
    revocations.revoke("new", "b", 20)
    expect(revocations.deniesAdmission("new", "b")).toBe(true)
    expect(revocations.deniesAdmission("new", "c")).toBe(false)
  })

  it("holds only the named attempt through expiry, without shortening an existing hold", () => {
    const revocations = new RelayOwnerRevocations(1)
    revocations.revoke("scan", "a", 30)
    revocations.revoke("scan", "a", 25)
    expect(revocations.deniesAdmission("scan", "a", 29)).toBe(true)
    expect(revocations.deniesAdmission("scan", "a", 30)).toBe(false)
    expect(revocations.deniesAdmission("scan", "b", 20)).toBe(false)
    expect(revocations.deniesAdmission("other", "a", 20)).toBe(false)
  })

  it("retains live holds at capacity and gates new admissions until the longest overflow expires", () => {
    const revocations = new RelayOwnerRevocations(1)
    revocations.revoke("scan", "a", 100)
    revocations.revoke("other", "b", 30)
    revocations.revoke("third", "c", 20)
    expect(revocations.deniesAdmission("new", "d", 29)).toBe(true)
    expect(revocations.deniesAdmission("new", "d", 30)).toBe(false)
    expect(revocations.deniesAdmission("scan", "a", 99)).toBe(true)
    revocations.sweep(100)
    revocations.revoke("next", "e", 120)
    expect(revocations.deniesAdmission("next", "e", 119)).toBe(true)
    expect(revocations.deniesAdmission("next", "f", 119)).toBe(false)
  })
})
