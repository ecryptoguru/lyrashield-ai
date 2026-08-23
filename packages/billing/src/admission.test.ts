import { describe, expect, it } from "vitest"
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
    expect(evaluateBillingAdmission({ ...input, workspaceId: "workspace-c" }).allowed).toBe(false)
  })

  it("fails closed on a malformed canary allowlist", () => {
    for (const canaryWorkspaceIds of ["workspace-a,,workspace-b", "workspace!a", ","]) {
      expect(
        evaluateBillingAdmission({
          mode: "canary",
          workspaceId: "workspace-a",
          canaryWorkspaceIds,
        })
      ).toEqual({ allowed: false, mode: "canary", reason: "invalid_allowlist" })
    }
  })

  it("admits authenticated workspaces when explicitly public", () => {
    expect(
      evaluateBillingAdmission({
        mode: "public",
        workspaceId: "workspace-a",
        canaryWorkspaceIds: "malformed!",
      })
    ).toEqual({ allowed: true, mode: "public", reason: "public" })
  })
})
