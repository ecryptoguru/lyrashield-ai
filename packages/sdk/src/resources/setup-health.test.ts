import { describe, expect, it } from "vitest"
import {
  SETUP_HEALTH_VERSION,
  SetupHealthSnapshotSchema as CanonicalSetupHealthSnapshotSchema,
} from "../../../types/src/setup-health"
import { SetupHealthSnapshotSchema } from "./setup-health"

const snapshot = {
  version: SETUP_HEALTH_VERSION,
  status: "blocked" as const,
  allowed: false,
  checkedAt: "2026-11-05T00:00:00.000Z",
  expiresAt: "2026-11-05T00:01:00.000Z",
  scopeFingerprint: "a".repeat(64),
  scope: {
    workspaceId: "ws-1",
    targetId: "target-1",
    goal: "TEST_APP",
    mode: "STANDARD",
    workflow: "REVIEW_TARGET",
    policyFingerprint: null,
    attachmentFingerprint: null,
    authorizationFingerprint: null,
    sourceRevision: null,
  },
  checks: [
    {
      code: "DOMAIN_VERIFICATION_REQUIRED",
      status: "blocked" as const,
      explanation: "Verify control of this domain once.",
      recoveryAction: "VERIFY_DOMAIN" as const,
    },
  ],
  primaryCheck: "DOMAIN_VERIFICATION_REQUIRED",
  limitations: [],
}

describe("SDK setup-health schema parity", () => {
  it("accepts and normalizes valid snapshots exactly like the canonical contract", () => {
    expect(SetupHealthSnapshotSchema.parse(snapshot)).toEqual(
      CanonicalSetupHealthSnapshotSchema.parse(snapshot)
    )
  })

  it("rejects the same drift as the canonical contract", () => {
    const invalidSnapshots = [
      { ...snapshot, checkedAt: "not-a-timestamp" },
      { ...snapshot, primaryCheck: "X".repeat(97) },
      {
        ...snapshot,
        checks: [{ ...snapshot.checks[0], code: "X".repeat(97) }],
      },
      {
        ...snapshot,
        checks: [{ ...snapshot.checks[0], explanation: "X".repeat(501) }],
      },
      { ...snapshot, limitations: ["X".repeat(501)] },
      { ...snapshot, scope: { ...snapshot.scope, targetId: "" } },
    ]

    for (const invalid of invalidSnapshots) {
      expect(CanonicalSetupHealthSnapshotSchema.safeParse(invalid).success).toBe(false)
      expect(SetupHealthSnapshotSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it("strips unknown fields identically instead of passing them through", () => {
    const withExtra = { ...snapshot, extraField: "must-not-pass-through" }
    const parsed = SetupHealthSnapshotSchema.parse(withExtra)

    expect(parsed).toEqual(CanonicalSetupHealthSnapshotSchema.parse(withExtra))
    expect(parsed).not.toHaveProperty("extraField")
  })
})
