import { describe, expect, it, vi } from "vitest"
import { apiGet } from "@/lib/api-client"
import { readScanProgress } from "./scan-progress-webmcp"

vi.mock("@/lib/api-client", () => ({ apiGet: vi.fn() }))

describe("scan progress WebMCP read", () => {
  it("returns only bounded recorded progress, never event text or evidence", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({
      id: "scan1",
      workspaceId: "ws1",
      status: "RUNNING",
      startedAt: null,
      endedAt: null,
      events: [{ stage: "analysis", message: "secret source text" }],
      coverageReceipts: [{ id: "receipt1", evidenceUri: "encrypted://private" }],
      resultManifest: null,
    })
    const result = await readScanProgress("scan1", "ws1", new AbortController().signal)
    expect(result).toMatchObject({ status: "RUNNING", stage: "analysis", progressPercent: null })
    expect(JSON.stringify(result)).not.toMatch(/secret source|encrypted:\/\//)
    expect(vi.mocked(apiGet).mock.calls[0]?.[0]).toBe("/api/scans/scan1?workspaceId=ws1")
  })

  it("rejects a mismatched server response", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ id: "foreign", workspaceId: "ws1" })
    await expect(readScanProgress("scan1", "ws1", new AbortController().signal)).rejects.toThrow(
      "did not match"
    )
  })
})
