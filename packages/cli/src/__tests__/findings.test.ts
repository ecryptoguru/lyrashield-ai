import { describe, it, expect, vi } from "vitest"
import type { Output } from "../output.js"
import { handleFindings } from "../commands/findings.js"

vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: vi.fn(async () => ({
    apiKey: "lsk_testkey123",
    apiUrl: "https://app.lyrashieldai.com",
    workspaceId: "ws-test",
    installId: "i-test",
    source: "env" as const,
  })),
  requireWorkspace: vi.fn(() => "ws-test"),
}))

describe("lyrashield findings command URL construction", () => {
  it("calls the absolute API URL without double-prefixing /api/v1", async () => {
    const originalFetch = globalThis.fetch
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
    })
    globalThis.fetch = mockFetch

    try {
      const output: Output = {
        json: false,
        quiet: false,
        log: vi.fn(),
        notice: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        result: vi.fn(),
        fail: (error: string): never => {
          throw new Error(error)
        },
      }

      const code = await handleFindings([], output)
      expect(code).toBe(0)
      expect(mockFetch).toHaveBeenCalled()

      const url = mockFetch.mock.calls[0]?.[0] as string
      expect(url).toBe("https://app.lyrashieldai.com/api/v1/findings?workspaceId=ws-test")
      expect(url).not.toContain("/api/v1/api/v1")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
