import type { SetupHealthSnapshot } from "@lyrashield/types"
import { describe, expect, it } from "vitest"
import { presentTargetSetupHealth } from "./target-setup-health"

const ready: SetupHealthSnapshot = {
  version: "lyrashield-setup-health/1.0.0" as const,
  status: "ready" as const,
  allowed: true,
  checkedAt: "2026-11-05T00:00:00.000Z",
  expiresAt: "2026-11-05T00:01:00.000Z",
  scopeFingerprint: "a".repeat(64),
  scope: {
    workspaceId: "ws-1",
    targetId: "target-1",
    goal: "LAUNCH_REVIEW",
    mode: "STANDARD",
    workflow: "REVIEW_TARGET",
    policyFingerprint: null,
    attachmentFingerprint: null,
    authorizationFingerprint: null,
    sourceRevision: null,
  },
  checks: [],
  primaryCheck: "SETUP_READY",
  limitations: [],
}

describe("target setup health presentation", () => {
  it("exposes the shared blocker and recovery code to web", () => {
    expect(
      presentTargetSetupHealth({
        ...ready,
        status: "blocked",
        allowed: false,
        primaryCheck: "DOMAIN_VERIFICATION_REQUIRED",
        checks: [
          {
            code: "DOMAIN_VERIFICATION_REQUIRED",
            status: "blocked",
            explanation: "Verify control of this domain once.",
            recoveryAction: "VERIFY_DOMAIN",
          },
        ],
      })
    ).toEqual({
      label: "Setup blocked",
      explanation: "Verify control of this domain once.",
      code: "DOMAIN_VERIFICATION_REQUIRED",
      recoveryAction: "VERIFY_DOMAIN",
    })
  })

  it("labels dependency uncertainty separately from a permission denial", () => {
    expect(
      presentTargetSetupHealth({
        ...ready,
        status: "unknown",
        allowed: false,
        primaryCheck: "WORKER_READINESS_UNAVAILABLE",
        checks: [
          {
            code: "WORKER_READINESS_UNAVAILABLE",
            status: "unknown",
            explanation: "Worker readiness could not be established.",
            recoveryAction: "WAIT_FOR_WORKER",
          },
        ],
      })
    ).toMatchObject({ label: "Setup status unknown", recoveryAction: "WAIT_FOR_WORKER" })
  })
})
