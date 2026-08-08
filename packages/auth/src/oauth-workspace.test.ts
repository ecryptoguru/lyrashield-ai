import { describe, expect, it } from "vitest"
import { activeWorkspaceIdFromCookie } from "./oauth-workspace"

describe("activeWorkspaceIdFromCookie", () => {
  it("uses the selected workspace cookie without accepting malformed values", () => {
    expect(activeWorkspaceIdFromCookie("session=x; activeWorkspaceId=workspace%2Ddemo")).toBe(
      "workspace-demo"
    )
    expect(activeWorkspaceIdFromCookie("activeWorkspaceId=%")).toBeUndefined()
    expect(activeWorkspaceIdFromCookie(null)).toBeUndefined()
  })
})
