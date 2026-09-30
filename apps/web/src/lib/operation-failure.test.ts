import { describe, expect, it } from "vitest"
import { presentOperationFailure } from "./operation-failure"

const REQUIRED_CASES: [string, RegExp][] = [
  ["TRIAL_EXPIRED", /trial/i],
  ["NO_MINUTES_REMAINING", /minutes|usage/i],
  ["STOPPED_BUDGET", /protected per-scan budget/i],
  ["TIMED_OUT", /timed out/i],
  ["TARGET_LIMIT_REACHED", /target limit/i],
  ["TARGET_EXISTS", /already exists/i],
  ["DEEP_NOT_ALLOWED", /deep/i],
  ["WORKSPACE_NOT_FOUND", /no longer available/i],
  ["SSRF_BLOCKED", /internal, private/i],
  ["TARGET_NOT_FOUND", /no longer exists/i],
  ["TARGET_TYPE_UNSUPPORTED", /not supported/i],
  ["POLICY_NOT_FOUND", /policy/i],
  ["CONNECTION_EXPIRED", /expired/i],
  ["NO_REPOSITORIES", /no accessible repositories/i],
  ["TARGET_AUTHORIZATION_FAILED", /ownership/i],
  ["VERIFICATION_REQUIRED", /ownership/i],
  ["INSTALLATION_ALREADY_CLAIMED", /different workspace/i],
  ["QUEUE", /worker capacity/i],
  ["SERVICE_UNAVAILABLE", /temporarily unavailable/i],
  ["COVERAGE_INCOMPLETE", /without evaluating/i],
]

describe("operation failure presentation (W1-07)", () => {
  it.each(REQUIRED_CASES)("maps %s to cause, effect, and recovery", (code, causePattern) => {
    const presentation = presentOperationFailure(code)
    expect(presentation.cause, code).toMatch(causePattern)
    expect(presentation.effect, code).toBeTruthy()
    expect(presentation.recovery, code).toBeTruthy()
  })

  it("binds the target name into authorization failures without leaking internals", () => {
    const presentation = presentOperationFailure("TARGET_AUTHORIZATION_FAILED", {
      targetName: "checkout-service",
    })
    expect(presentation.cause).toContain("checkout-service")
    expect(presentation.recovery).toMatch(/authorization prompt/i)
  })

  it("routes target conflicts to the workspace target list", () => {
    const presentation = presentOperationFailure("TARGET_EXISTS")

    expect(presentation.effect).toMatch(/no duplicate target was created/i)
    expect(presentation.recoveryHref).toBe("/dashboard/targets")
  })

  it("never echoes unknown error text into the presentation", () => {
    const presentation = presentOperationFailure("SOME_NEW_INTERNAL_CODE")
    expect(presentation.cause).not.toMatch(/SOME_NEW_INTERNAL_CODE/)
    expect(presentation.cause).toBe(
      "The request did not complete. Check its status before starting another action."
    )
    expect(presentation.effect).not.toMatch(
      /no billable work|nothing was charged|nothing was started/i
    )
    expect(presentation.recovery).toBeTruthy()
  })

  it("distinguishes account minutes from a per-scan protected budget", () => {
    const accountLimit = presentOperationFailure("NO_MINUTES_REMAINING")
    const scanLimit = presentOperationFailure("STOPPED_BUDGET")

    expect(accountLimit.cause).toContain("billing account")
    expect(accountLimit.cause).toContain("minutes")
    expect(scanLimit.cause).toContain("per-scan budget")
    expect(scanLimit.effect).toContain("does not show how many minutes remain")
  })

  it("reserves no-charge claims for known admission rejections", () => {
    expect(presentOperationFailure("TARGET_TYPE_UNSUPPORTED").effect).toBe(
      "Nothing was started and nothing was charged."
    )

    for (const code of [
      "QUEUE",
      "WORKER_UNAVAILABLE",
      "TIMED_OUT",
      "FAILED",
      "SERVICE_UNAVAILABLE",
      "INTERNAL_ERROR",
      "UNKNOWN_FUTURE_CODE",
    ]) {
      const presentation = presentOperationFailure(code)
      const copy = `${presentation.cause} ${presentation.effect} ${presentation.recovery}`
      expect(copy, code).not.toMatch(/no billable work|nothing was charged|nothing was started/i)
      expect(copy, code).toMatch(/check|review/i)
    }
  })

  it("always offers a recovery action, never an automatic approval or paid replay", () => {
    for (const code of [
      "TRIAL_EXPIRED",
      "SSRF_BLOCKED",
      "CONNECTION_EXPIRED",
      "UNKNOWN_FUTURE_CODE",
    ]) {
      const presentation = presentOperationFailure(code)
      expect(presentation.recovery.length).toBeGreaterThan(0)
      expect(presentation.recovery.toLowerCase()).not.toContain("auto-approve")
      expect(presentation.recovery.toLowerCase()).not.toContain("paid replay")
    }
  })
})
