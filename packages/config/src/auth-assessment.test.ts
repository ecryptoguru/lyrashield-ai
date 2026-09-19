import { describe, expect, it } from "vitest"
import {
  evaluateAuthAssessmentAdmission,
  parseAuthAssessmentAllowlist,
} from "./auth-assessment"

describe("parseAuthAssessmentAllowlist", () => {
  it("returns an empty list for a blank value", () => {
    expect(parseAuthAssessmentAllowlist("")).toEqual([])
    expect(parseAuthAssessmentAllowlist("   ")).toEqual([])
  })

  it("parses workspace and workspace:target entries", () => {
    expect(parseAuthAssessmentAllowlist("ws_1, ws_2:t_9 ,ws_3:t_1")).toEqual([
      { workspaceId: "ws_1" },
      { workspaceId: "ws_2", targetId: "t_9" },
      { workspaceId: "ws_3", targetId: "t_1" },
    ])
  })

  it("fails closed when any entry is malformed", () => {
    expect(parseAuthAssessmentAllowlist("ws_1, bad entry!")).toBeNull()
    expect(parseAuthAssessmentAllowlist("ws_1:")).toBeNull()
    expect(parseAuthAssessmentAllowlist(":target")).toBeNull()
    expect(parseAuthAssessmentAllowlist("a:b:c")).toBeNull()
    expect(parseAuthAssessmentAllowlist("ws,ws2:target,")).toBeNull()
  })
})

describe("evaluateAuthAssessmentAdmission", () => {
  const allowlist = "ws_canary,ws_scoped:t_allowed"

  it("denies when the flag is off — even for an allowlisted workspace", () => {
    expect(
      evaluateAuthAssessmentAdmission({
        enabled: false,
        allowlist,
        workspaceId: "ws_canary",
        targetId: "any",
      })
    ).toEqual({ allowed: false, reason: "flag_off" })
  })

  it("denies an enabled flag with an empty allowlist", () => {
    expect(
      evaluateAuthAssessmentAdmission({
        enabled: true,
        allowlist: "",
        workspaceId: "ws_canary",
        targetId: "any",
      })
    ).toEqual({ allowed: false, reason: "not_allowlisted" })
  })

  it("denies an enabled flag with a malformed allowlist", () => {
    expect(
      evaluateAuthAssessmentAdmission({
        enabled: true,
        allowlist: "ws_1, bogus!!",
        workspaceId: "ws_1",
        targetId: "any",
      })
    ).toEqual({ allowed: false, reason: "invalid_allowlist" })
  })

  it("admits a workspace-level allowlist entry for any of its targets", () => {
    expect(
      evaluateAuthAssessmentAdmission({
        enabled: true,
        allowlist,
        workspaceId: "ws_canary",
        targetId: "t_other",
      })
    ).toEqual({ allowed: true, reason: "allowlisted" })
  })

  it("admits a workspace:target entry only for that exact target", () => {
    expect(
      evaluateAuthAssessmentAdmission({
        enabled: true,
        allowlist,
        workspaceId: "ws_scoped",
        targetId: "t_allowed",
      })
    ).toEqual({ allowed: true, reason: "allowlisted" })
    expect(
      evaluateAuthAssessmentAdmission({
        enabled: true,
        allowlist,
        workspaceId: "ws_scoped",
        targetId: "t_other",
      })
    ).toEqual({ allowed: false, reason: "not_allowlisted" })
  })

  it("denies a target-scoped entry applied to a different workspace", () => {
    expect(
      evaluateAuthAssessmentAdmission({
        enabled: true,
        allowlist,
        workspaceId: "ws_other",
        targetId: "t_allowed",
      })
    ).toEqual({ allowed: false, reason: "not_allowlisted" })
  })
})
