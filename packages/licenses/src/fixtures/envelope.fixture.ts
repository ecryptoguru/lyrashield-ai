/** Shared v1 envelope fixtures — single source of truth for TS + Rust golden tests. */
import activateEnvelope from "./activate-envelope.json" with { type: "json" }
import verifyEnvelope from "./verify-envelope.json" with { type: "json" }

export const activateFixture = activateEnvelope as {
  success: true
  data: { version: 1; license: unknown; blob: string; licenseId: string }
}
export const verifyFixture = verifyEnvelope as {
  success: true
  data: { version: 1; valid: boolean; revoked: boolean; updateEligible: boolean }
}
