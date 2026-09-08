import { describe, expect, it } from "vitest"
import { activeWorkspaceIdFromCookie, needsOAuthWorkspaceSelection } from "./oauth-workspace"

describe("activeWorkspaceIdFromCookie", () => {
  it("uses the selected workspace cookie without accepting malformed values", () => {
    expect(activeWorkspaceIdFromCookie("session=x; activeWorkspaceId=workspace%2Ddemo")).toBe(
      "workspace-demo"
    )
    expect(activeWorkspaceIdFromCookie("activeWorkspaceId=%")).toBeUndefined()
    expect(activeWorkspaceIdFromCookie(null)).toBeUndefined()
  })
})

describe("needsOAuthWorkspaceSelection", () => {
  it("stops redirecting after the signed-in user selects an accessible workspace", () => {
    expect(needsOAuthWorkspaceSelection("workspace-1", "user-1", "user-1")).toBe(false)
  })

  it("requires selection when workspace or matching session identity is missing", () => {
    expect(needsOAuthWorkspaceSelection(undefined, "user-1", "user-1")).toBe(true)
    expect(needsOAuthWorkspaceSelection("workspace-1", "user-2", "user-1")).toBe(true)
  })
})
