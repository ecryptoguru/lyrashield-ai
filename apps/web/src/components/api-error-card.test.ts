import { describe, expect, it } from "vitest"
import { safeApiErrorMessage } from "./api-error-card"

describe("safeApiErrorMessage", () => {
  it("removes control characters and bounds untrusted error text", () => {
    expect(safeApiErrorMessage("failed\u0000\ntry again")).toBe("failed  try again")
    expect(safeApiErrorMessage("x".repeat(600))).toBe(`${"x".repeat(500)}…`)
    expect(safeApiErrorMessage(undefined)).toBe("Unknown error")
  })
})
