import { describe, expect, it, vi } from "vitest"
import type { LyraShieldClient } from "../client"
import { getLaunchReadiness } from "../resources/launch-readiness"

describe("getLaunchReadiness", () => {
  it("preserves defined empty release identities for API validation", async () => {
    const request = vi.fn().mockResolvedValue({})
    const client = { request } as unknown as LyraShieldClient

    await getLaunchReadiness(client, { workspaceId: "workspace-1", commit: "" })

    expect(request.mock.calls[0]?.[1]).toBe("/launch-readiness?workspaceId=workspace-1&commit=")
  })
})
