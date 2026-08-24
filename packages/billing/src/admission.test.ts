import { describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/config", () => ({
  env: {
    POLAR_BILLING_ADMISSION: "off",
    RAZORPAY_BILLING_ADMISSION: "off",
    BILLING_CANARY_WORKSPACE_IDS: "",
    POLAR_LOCAL_BILLING_ADMISSION: "off",
    RAZORPAY_LOCAL_BILLING_ADMISSION: "off",
  },
}))

import { evaluateBillingAdmission } from "./admission"

describe("billing admission", () => {
  it("fails closed when a provider is off", () => {
    expect(
      evaluateBillingAdmission({
        mode: "off",
        workspaceId: "workspace-a",
        canaryWorkspaceIds: "workspace-a",
      })
    ).toEqual({ allowed: false, mode: "off", reason: "provider_off" })
  })

  it("admits only exact canary workspace IDs", () => {
    const input = { mode: "canary" as const, canaryWorkspaceIds: "workspace-a,workspace-b" }
    expect(evaluateBillingAdmission({ ...input, workspaceId: "workspace-a" }).allowed).toBe(true)
    expect(evaluateBillingAdmission({ ...input, workspaceId: "workspace" }).allowed).toBe(false)
  })

  it("fails closed on malformed canary input", () => {
    for (const canaryWorkspaceIds of ["workspace-a,,workspace-b", "workspace!a", ","]) {
      expect(
        evaluateBillingAdmission({ mode: "canary", workspaceId: "workspace-a", canaryWorkspaceIds })
      ).toEqual({ allowed: false, mode: "canary", reason: "invalid_allowlist" })
    }
  })

  it("admits authenticated workspaces only when explicitly public", () => {
    expect(
      evaluateBillingAdmission({
        mode: "public",
        workspaceId: "workspace-a",
        canaryWorkspaceIds: "malformed!",
      })
    ).toEqual({ allowed: true, mode: "public", reason: "public" })
  })
})
