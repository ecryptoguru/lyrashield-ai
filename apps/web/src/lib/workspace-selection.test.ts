import { describe, expect, it } from "vitest"
import { selectActiveWorkspaceId } from "./workspace-selection"

describe("selectActiveWorkspaceId", () => {
  const memberships = [{ workspaceId: "ws-1" }, { workspaceId: "ws-2" }]

  it("uses the requested workspace only when the user belongs to it", () => {
    expect(selectActiveWorkspaceId(memberships, "ws-2")).toBe("ws-2")
  })

  it("falls back to the first membership for an invalid selection", () => {
    expect(selectActiveWorkspaceId(memberships, "ws-other")).toBe("ws-1")
  })
})
