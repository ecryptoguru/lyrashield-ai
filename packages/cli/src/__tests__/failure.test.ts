import { describe, expect, it } from "vitest"
import { describeCliFailure } from "../failure.js"

describe("describeCliFailure", () => {
  it("maps HTTP 402 to a dedicated exit code and a Billing pointer", () => {
    const err = Object.assign(new Error("PAYMENT_REQUIRED"), { status: 402 })
    expect(describeCliFailure(err)).toEqual({
      message: "Plan or agent-minute balance does not allow this. Open Billing.",
      exitCode: 6,
    })
  })

  it("keeps the existing auth, rate-limit and default mappings", () => {
    expect(describeCliFailure(Object.assign(new Error("x"), { status: 401 })).exitCode).toBe(3)
    expect(describeCliFailure(Object.assign(new Error("x"), { status: 403 })).exitCode).toBe(3)
    expect(describeCliFailure(Object.assign(new Error("x"), { status: 429 })).exitCode).toBe(5)
    expect(describeCliFailure(new Error("plain failure"))).toEqual({
      message: "plain failure",
      exitCode: 4,
    })
  })
})
