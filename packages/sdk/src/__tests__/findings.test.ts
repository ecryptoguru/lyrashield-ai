import { describe, expect, it, vi } from "vitest"
import { LyraShieldClient } from "../client"
import { listFindings } from "../resources/findings"

describe("findings scan filters", () => {
  it("keeps the origin scan and observed scan as independent query parameters", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
    }))
    const client = new LyraShieldClient({
      apiKey: "test-key",
      apiUrl: "http://localhost:3000",
      workspaceId: "workspace-1",
      fetchFn: fetchFn as unknown as typeof fetch,
    })

    await listFindings(client, {
      targetId: "target-1",
      scanId: "origin-scan",
      observedInScanId: "observed-scan",
    })

    const requestedUrl = new URL(fetchFn.mock.calls[0]![0] as string)
    expect(requestedUrl.searchParams.get("workspaceId")).toBe("workspace-1")
    expect(requestedUrl.searchParams.get("targetId")).toBe("target-1")
    expect(requestedUrl.searchParams.get("scanId")).toBe("origin-scan")
    expect(requestedUrl.searchParams.get("observedInScanId")).toBe("observed-scan")
  })
})
