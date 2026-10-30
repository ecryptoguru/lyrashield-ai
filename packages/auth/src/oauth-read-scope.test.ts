import { describe, expect, it } from "vitest"
import { resolveOAuthReadScope } from "./oauth-read-scope"
import type { AuthSession } from "./session"

const selected = {
  oauth: {
    userId: "user-1",
    workspaceId: "ws-1",
    scopes: ["lyrashield.read"],
    connectionId: "connection-1",
    allTargets: false,
    allowedTargetIds: ["target-1", "target-2"],
  },
} satisfies Pick<AuthSession, "oauth">

describe("resolveOAuthReadScope", () => {
  it("limits an omitted target to the selected targets", () => {
    expect(resolveOAuthReadScope(selected)).toEqual({ targetIds: ["target-1", "target-2"] })
  })

  it("accepts an explicitly granted target and rejects a different target", () => {
    expect(resolveOAuthReadScope(selected, "target-2")).toEqual({ targetId: "target-2" })
    expect(() => resolveOAuthReadScope(selected, "target-3")).toThrow("FORBIDDEN")
  })

  it("keeps empty and absent target grants empty rather than workspace-wide", () => {
    for (const allowedTargetIds of [[], undefined]) {
      const session = { oauth: { ...selected.oauth, allowedTargetIds } }
      expect(resolveOAuthReadScope(session)).toEqual({ targetIds: [] })
      expect(() => resolveOAuthReadScope(session, "target-1")).toThrow("FORBIDDEN")
    }
  })

  it("requires an explicit target for selected-target readiness", () => {
    expect(() => resolveOAuthReadScope(selected, undefined, true)).toThrow("FORBIDDEN")
    expect(resolveOAuthReadScope(selected, "target-1", true)).toEqual({ targetId: "target-1" })
  })

  it("preserves all-target delegation reads", () => {
    const session = { oauth: { ...selected.oauth, allTargets: true, allowedTargetIds: [] } }
    expect(resolveOAuthReadScope(session, undefined, true)).toEqual({})
    expect(resolveOAuthReadScope(session, "target-3")).toEqual({ targetId: "target-3" })
  })

  it("preserves browser, API-key, and legacy OAuth read semantics", () => {
    for (const session of [{}, { oauth: { ...selected.oauth, connectionId: undefined } }]) {
      expect(resolveOAuthReadScope(session)).toEqual({})
      expect(resolveOAuthReadScope(session, "target-3", true)).toEqual({ targetId: "target-3" })
    }
  })
})
