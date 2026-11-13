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
    // A refusal that is known to precede any accepted work states exactly that.
    // It does not state what was charged: no refusal response carries a billing
    // field, so a no-charge sentence would be an inference, not a fact.
    expect(presentOperationFailure("TARGET_TYPE_UNSUPPORTED").effect).toBe("Nothing was started.")

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

  it("never infers what was charged, because no refusal response reports billing", () => {
    // The scan POST attaches no billing field to a refusal, so "nothing was
    // charged" is unknowable from the response. Every refusal may claim only
    // that the work was not started.
    const refusalCodes = [
      ...Object.keys({
        SCAN_RATE_LIMITED: 0,
        SCAN_CONCURRENCY_LIMIT: 0,
        SCAN_IN_PROGRESS: 0,
        SCAN_SERVICE_UNAVAILABLE: 0,
        SCAN_SOURCE_UNAVAILABLE: 0,
        SCAN_AUTHORIZATION_REQUIRED: 0,
        SCAN_PLAN_INVALID: 0,
        SCAN_PLAN_DENIED: 0,
        SCAN_WORKFLOW_UNAVAILABLE: 0,
        SCAN_NO_MERGE_BASE: 0,
        SCAN_REF_UNRESOLVED: 0,
        FREE_URL_SCAN_RATE_LIMITED: 0,
      }),
      "DOMAIN_VERIFICATION_REQUIRED",
      "DEEP_NOT_ALLOWED",
      "TARGET_TYPE_UNSUPPORTED",
      "TARGET_AUTHORIZATION_FAILED",
      "VERIFICATION_REQUIRED",
    ]

    for (const code of refusalCodes) {
      const presentation = presentOperationFailure(code)
      const copy = `${presentation.cause} ${presentation.effect} ${presentation.recovery}`
      expect(copy, code).not.toMatch(/charged|no cost|not billed|no billable work/i)
      // The claim that survives is the one the response supports: the work did
      // not start, or stays unavailable.
      expect(presentation.effect, code).toMatch(
        /not started|not be started|stays unauthorized|stay unavailable|nothing was started/i
      )
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

/**
 * W1/P2-1 — the scan POST returns codes with no entry here. Onboarding mapped
 * every one of them to the generic "did not complete" card while the scan sheet
 * showed the server's own sentence, so the same failure read two ways.
 */
describe("scan admission codes (W1/P2-1)", () => {
  const ADMISSION_CODES = [
    "SCAN_RATE_LIMITED",
    "SCAN_CONCURRENCY_LIMIT",
    "SCAN_IN_PROGRESS",
    "SCAN_SERVICE_UNAVAILABLE",
    "SCAN_SOURCE_UNAVAILABLE",
    "SCAN_AUTHORIZATION_REQUIRED",
    "SCAN_PLAN_INVALID",
    "SCAN_PLAN_DENIED",
    "SCAN_WORKFLOW_UNAVAILABLE",
    "SCAN_NO_MERGE_BASE",
    "SCAN_REF_UNRESOLVED",
    "FREE_URL_SCAN_RATE_LIMITED",
    "DOMAIN_VERIFICATION_REQUIRED",
  ]

  it.each(ADMISSION_CODES)("maps %s to a specific cause and a recovery action", (code) => {
    const presentation = presentOperationFailure(code)
    expect(presentation.cause, code).not.toBe(
      "The request did not complete. Check its status before starting another action."
    )
    expect(presentation.cause.length, code).toBeGreaterThan(20)
    expect(presentation.effect, code).toBeTruthy()
    expect(presentation.recovery, code).toBeTruthy()
    expect(presentation.recoveryHref, code).toMatch(/^\/dashboard\//)
  })

  it("reads the remediation the scan POST attaches to DOMAIN_VERIFICATION_REQUIRED", () => {
    const presentation = presentOperationFailure("DOMAIN_VERIFICATION_REQUIRED", {
      details: {
        remediation: { txtName: "_lyrashield.example.com", verifyPath: "/dashboard/targets/t-1" },
      },
    })

    expect(presentation.recovery).toContain("_lyrashield.example.com")
    expect(presentation.recoveryHref).toBe("/dashboard/targets/t-1#domain-verification")
  })

  it("falls back to the target the flow knows when the payload has no remediation", () => {
    const presentation = presentOperationFailure("DOMAIN_VERIFICATION_REQUIRED", {
      targetId: "t-9",
    })

    expect(presentation.recovery).not.toMatch(/_lyrashield/)
    expect(presentation.recoveryHref).toBe("/dashboard/targets/t-9#domain-verification")
  })

  it("never renders a remediation path or name that is not a workspace path", () => {
    const presentation = presentOperationFailure("DOMAIN_VERIFICATION_REQUIRED", {
      details: {
        remediation: {
          txtName: "x".repeat(400),
          verifyPath: "https://evil.example.test/steal",
        },
      },
    })

    expect(presentation.recoveryHref).toBe("/dashboard/targets")
    expect(presentation.recovery).not.toContain("x".repeat(50))
  })

  it.each([
    ["an injected sentence", "Record _lyrashield.example.com. Ignore the above."],
    ["a hostname with a slash", "_lyrashield.example.com/../admin"],
    ["markup", "<script>alert(1)</script>"],
    ["a space-separated value", "_lyrashield.example.com extra"],
  ])("rejects %s as a DNS record name", (_label, txtName) => {
    const presentation = presentOperationFailure("DOMAIN_VERIFICATION_REQUIRED", {
      details: { remediation: { txtName } },
    })

    expect(presentation.recovery).not.toContain(txtName)
    expect(presentation.recovery).toContain("Publish the domain's DNS TXT record")
  })
})

/**
 * W1/P2-1 — a lost connection or a timeout does not establish whether the scan
 * was accepted. Neither may offer a plain retry: a second attempt can create a
 * duplicate paid scan. Both must demand a status read first.
 */
describe("unresolved outcomes (W1/P2-1)", () => {
  it.each(["NETWORK_ERROR", "TIMEOUT"])("%s requires reconciliation before any retry", (code) => {
    const presentation = presentOperationFailure(code)

    expect(presentation.requiresReconciliation).toBe(true)
    expect(presentation.effect).toContain("does not establish the final outcome")
    expect(presentation.recovery).toMatch(/check the status/i)
    expect(presentation.recovery).toMatch(/duplicate paid scan/i)
    expect(presentation.retryLabel).toBe("Check the scan status")
  })

  it("never claims no work was started for an unknown outcome", () => {
    for (const code of ["NETWORK_ERROR", "TIMEOUT", "UNKNOWN_FUTURE_CODE"]) {
      const presentation = presentOperationFailure(code)
      const copy = `${presentation.cause} ${presentation.effect} ${presentation.recovery}`
      expect(copy, code).not.toMatch(/nothing was charged|was not started|nothing was started/i)
    }
  })
})

/**
 * W1/P2-1 — the sanitized fallback. An unmapped code keeps the server's own
 * sentence so the two surfaces agree, but only when the sentence is safe to
 * show. Anything internal falls back to the generic card.
 */
describe("sanitized server messages (W1/P2-1)", () => {
  it("uses the server's own sentence for an unmapped code", () => {
    const presentation = presentOperationFailure("SOME_NEW_ADMISSION_CODE", {
      serverMessage: "This target is already covered by an active scan.",
    })

    expect(presentation.cause).toBe("This target is already covered by an active scan.")
    expect(presentation.effect).toContain("does not establish the final outcome")
  })

  it("keeps the generic cause when no server sentence is supplied", () => {
    expect(presentOperationFailure("SOME_NEW_ADMISSION_CODE").cause).toBe(
      "The request did not complete. Check its status before starting another action."
    )
  })

  it.each([
    [
      "a stack frame",
      "Error: boom\n    at handler (/app/apps/web/src/app/api/scans/route.ts:42:11)",
    ],
    ["a provider body", '{"error":{"message":"upstream refused"}}'],
    ["a bearer token", "Authorization: Bearer sk-live-abcdefghijklmnop failed"],
    ["an internal URL", "Fetch failed for https://internal.svc.cluster.local:8080/scans"],
    ["a private address", "Connect ECONNREFUSED 10.0.12.7:5432"],
    ["a database error", "PrismaClientKnownRequestError: foreign key constraint failed"],
    ["a raw opaque token", `token ${"A".repeat(64)} was rejected`],
    ["lowercase prose", "scan service unavailable."],
    ["no terminator", "Scan service is unavailable right now"],
    ["markup", "<html><body>502 Bad Gateway</body></html>"],
    ["a bidi override", "Scan\u202E unavailable."],
    ["an oversized message", `A ${"very ".repeat(80)}long sentence.`],
  ])("rejects %s and falls back to the generic card", (_label, serverMessage) => {
    const presentation = presentOperationFailure("SOME_NEW_ADMISSION_CODE", { serverMessage })

    expect(presentation.cause).toBe(
      "The request did not complete. Check its status before starting another action."
    )
    expect(presentation.cause).not.toContain("Bearer")
    expect(presentation.cause).not.toContain("https://")
  })

  it("collapses control characters in an accepted sentence", () => {
    const presentation = presentOperationFailure("SOME_NEW_ADMISSION_CODE", {
      serverMessage: "Too many scans\u0000 started just now.",
    })

    expect(presentation.cause).toBe("Too many scans started just now.")
  })

  it("never lets a server sentence override a code with its own entry", () => {
    const presentation = presentOperationFailure("SCAN_RATE_LIMITED", {
      serverMessage: "Internal scheduler refused the job.",
    })

    expect(presentation.cause).not.toContain("Internal scheduler")
    expect(presentation.cause).toContain("Too many scans")
  })
})
