import { describe, expect, it } from "vitest"
import {
  buildSetupAuthorityProjection,
  type SetupAuthorityEvidence,
} from "./setup-health-authority"

const evidence: SetupAuthorityEvidence = {
  intent: {
    workspaceId: "ws-1",
    targetId: "target-1",
    goal: "LAUNCH_REVIEW",
    mode: "STANDARD",
    workflow: "REVIEW_CHANGES",
    policyId: "private-policy",
    engineBudgetCeilingUsd: 1,
    baseRef: "main",
    headRef: "A".repeat(40),
    attachmentIds: ["attachment-b", "attachment-a", "attachment-a"],
    authorizationRef: null,
  },
  actor: { userId: "private-sponsor", membership: { role: "OWNER", status: "active" } },
  target: { repo: "private-repository", branch: "main", installationId: "123" },
  connection: { id: "connection-1", status: "active" },
  source: null,
  policy: { id: "private-policy", maxBudgetUsd: 0.47, blockedPaths: ["/secret"] },
  budget: { amount: 0.47 },
  entitlement: { accountId: "private-sponsor", plan: "PRO", remainingMinutes: 10 },
  attachments: [
    { id: "attachment-a", checksum: "a" },
    { id: "attachment-b", checksum: "b" },
  ],
  authorization: null,
  relay: { available: true },
  network: null,
}
const key = "test-secret-with-at-least-thirty-two-characters"

describe("setup authority fingerprint", () => {
  it("uses normalized intent and the evaluated server-side authority without serializing secrets", () => {
    const first = buildSetupAuthorityProjection(evidence, key)
    const equivalent = buildSetupAuthorityProjection(
      {
        ...evidence,
        intent: {
          ...evidence.intent!,
          headRef: "a".repeat(40),
          attachmentIds: ["attachment-a", "attachment-b"],
        },
        attachments: [...(evidence.attachments as object[])].reverse(),
      },
      key
    )
    expect(first.scopeFingerprint).toBe(equivalent.scopeFingerprint)
    expect(first.scope.sourceRevision).toBeNull()
    expect(JSON.stringify(first)).not.toContain("private-sponsor")
    expect(JSON.stringify(first)).not.toContain("private-repository")
    expect(JSON.stringify(first)).not.toContain("0.47")
    expect(JSON.stringify(first)).not.toContain("/secret")
  })

  it.each([
    ["policy", { ...evidence, policy: { ...(evidence.policy as object), maxBudgetUsd: 0.2 } }],
    ["budget", { ...evidence, budget: { amount: 0.2 } }],
    [
      "sponsor",
      {
        ...evidence,
        entitlement: { accountId: "another-account", plan: "PRO", remainingMinutes: 10 },
      },
    ],
    [
      "membership",
      {
        ...evidence,
        actor: { userId: "private-sponsor", membership: { role: "MEMBER", status: "active" } },
      },
    ],
    [
      "connection",
      {
        ...evidence,
        actor: {
          userId: "private-sponsor",
          membership: { role: "OWNER" },
          connection: { authorizationVersion: 2 },
        },
      },
    ],
    [
      "grant",
      { ...evidence, authorization: { planId: "new-grant", expiresAt: "2026-11-12T00:00:00Z" } },
    ],
    [
      "repository",
      {
        ...evidence,
        target: { repo: "another-repository", branch: "main", installationId: "123" },
      },
    ],
    ["base ref", { ...evidence, intent: { ...evidence.intent!, baseRef: "release" } }],
    ["attachment", { ...evidence, attachments: [{ id: "attachment-a", checksum: "changed" }] }],
  ])("changes when %s changes", (_label, changed) => {
    expect(buildSetupAuthorityProjection(changed, key).scopeFingerprint).not.toBe(
      buildSetupAuthorityProjection(evidence, key).scopeFingerprint
    )
  })

  it("keeps unobserved authority unavailable instead of hashing request identifiers as resolved policy", () => {
    const result = buildSetupAuthorityProjection(
      { ...evidence, policy: "UNAVAILABLE", entitlement: "UNAVAILABLE" },
      key
    )
    expect(result.scope.policyFingerprint).toBeNull()
    expect(result.complete).toBe(false)
  })
})
