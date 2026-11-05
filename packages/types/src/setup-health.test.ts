import { describe, expect, it } from "vitest"
import {
  buildSetupHealthSnapshot,
  setupHealthSnapshotSchema,
  SETUP_HEALTH_VERSION,
} from "./setup-health"

const scope = {
  workspaceId: "ws-1",
  targetId: "target-1",
  goal: "TEST_APP",
  mode: "STANDARD",
  workflow: "REVIEW_TARGET",
  policyFingerprint: null,
  attachmentFingerprint: null,
  authorizationFingerprint: null,
  sourceRevision: "a".repeat(40),
}

describe("setup health contract", () => {
  it("preserves a legacy denial code and assigns its canonical recovery action", () => {
    const snapshot = buildSetupHealthSnapshot({
      allowed: false,
      code: "DOMAIN_VERIFICATION_REQUIRED",
      message: "Verify control of this domain once.",
      limitations: [],
      scope,
      scopeFingerprint: "f".repeat(64),
      now: new Date("2026-11-05T00:00:00.000Z"),
    })

    expect(snapshot.status).toBe("blocked")
    expect(snapshot.primaryCheck).toBe("DOMAIN_VERIFICATION_REQUIRED")
    expect(snapshot.checks).toEqual([
      {
        code: "DOMAIN_VERIFICATION_REQUIRED",
        status: "blocked",
        explanation: "Verify control of this domain once.",
        recoveryAction: "VERIFY_DOMAIN",
      },
    ])
    expect(snapshot.expiresAt).toBe("2026-11-05T00:01:00.000Z")
  })

  it("projects every legacy blocker as a check while retaining the first as primary", () => {
    const snapshot = buildSetupHealthSnapshot({
      allowed: false,
      blockers: [
        {
          code: "NO_MINUTES_REMAINING",
          message: "No agent minutes remain.",
        },
        {
          code: "DOMAIN_VERIFICATION_REQUIRED",
          message: "Verify control of this domain once.",
        },
      ],
      limitations: [],
      scope,
      scopeFingerprint: "c".repeat(64),
      now: new Date("2026-11-05T00:00:00.000Z"),
    })

    expect(snapshot.primaryCheck).toBe("NO_MINUTES_REMAINING")
    expect(snapshot.checks).toEqual([
      {
        code: "NO_MINUTES_REMAINING",
        status: "blocked",
        explanation: "No agent minutes remain.",
        recoveryAction: "REVIEW_BILLING",
      },
      {
        code: "DOMAIN_VERIFICATION_REQUIRED",
        status: "blocked",
        explanation: "Verify control of this domain once.",
        recoveryAction: "VERIFY_DOMAIN",
      },
    ])
  })

  it("propagates dependency uncertainty to every projected blocker", () => {
    const snapshot = buildSetupHealthSnapshot({
      allowed: false,
      dependencyUnavailable: true,
      blockers: [
        { code: "NO_MINUTES_REMAINING", message: "Entitlement state is unavailable." },
        { code: "WORKER_READINESS_UNAVAILABLE", message: "Worker readiness is unavailable." },
      ],
      limitations: [],
      scope,
      scopeFingerprint: "b".repeat(64),
      now: new Date("2026-11-05T00:00:00.000Z"),
    })

    expect(snapshot.status).toBe("unknown")
    expect(snapshot.checks).toHaveLength(2)
    expect(snapshot.checks.every((check) => check.status === "unknown")).toBe(true)
  })

  it("builds a ready snapshot and keeps submission-time limitations advisory", () => {
    const snapshot = buildSetupHealthSnapshot({
      allowed: true,
      code: null,
      message: null,
      limitations: ["Comparison refs resolve only when the scan is submitted."],
      scope,
      scopeFingerprint: "e".repeat(64),
      now: new Date("2026-11-05T00:00:00.000Z"),
    })

    expect(snapshot.version).toBe(SETUP_HEALTH_VERSION)
    expect(snapshot.status).toBe("ready")
    expect(snapshot.primaryCheck).toBe("SETUP_READY")
    expect(snapshot.limitations).toHaveLength(1)
    expect(setupHealthSnapshotSchema.parse(snapshot)).toEqual(snapshot)
  })

  it("uses unknown for dependency uncertainty instead of claiming permission denial", () => {
    const snapshot = buildSetupHealthSnapshot({
      allowed: false,
      dependencyUnavailable: true,
      code: "WORKER_READINESS_UNAVAILABLE",
      message: "Worker readiness could not be established.",
      limitations: [],
      scope,
      scopeFingerprint: "d".repeat(64),
      now: new Date("2026-11-05T00:00:00.000Z"),
    })

    expect(snapshot.status).toBe("unknown")
    expect(snapshot.checks[0]).toMatchObject({
      status: "unknown",
      recoveryAction: "WAIT_FOR_WORKER",
    })
  })
})
