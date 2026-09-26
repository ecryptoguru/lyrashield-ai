import { describe, expect, it, vi } from "vitest"
import { apiGet } from "@/lib/api-client"
import { readVisibleReport } from "./reports-webmcp"
import type { ReportItem } from "./reports-model"

vi.mock("@/lib/api-client", () => ({ apiGet: vi.fn() }))

const visible = [{ id: "report1" }] as ReportItem[]
const signal = new AbortController().signal

describe("report WebMCP read", () => {
  it("rejects report IDs outside the visible page before network access", async () => {
    await expect(readVisibleReport("foreign", "ws1", visible, signal)).rejects.toThrow(
      "not visible"
    )
    expect(apiGet).not.toHaveBeenCalled()
  })

  it("returns metadata without report body, evidence, or share token", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({
      id: "report1",
      scanSummary: { scanId: "scan1" },
      title: "Summary",
      status: "COMPLETED",
      type: "executive",
      format: "pdf",
      createdAt: "2026-01-01",
      body: "private evidence",
      shareTokenHash: "secret",
    })
    const result = await readVisibleReport("report1", "ws1", visible, signal)
    expect(result).toMatchObject({ reportId: "report1", available: true })
    expect(JSON.stringify(result)).not.toMatch(/private evidence|shareTokenHash|secret/)
    expect(vi.mocked(apiGet).mock.calls[0]?.[0]).toBe("/api/reports/report1?workspaceId=ws1")
  })
})
