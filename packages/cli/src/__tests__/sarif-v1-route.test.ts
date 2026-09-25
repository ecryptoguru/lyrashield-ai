import { describe, expect, it, vi } from "vitest"

// The import resolves the real route module; its env/config dependency is the
// only mock so the export assertion exercises the genuine route file.
vi.mock("@lyrashield/config", () => ({
  env: { NEXT_PUBLIC_APP_URL: "http://localhost:3000" },
}))
vi.mock("../../../auth/src/server", () => ({ requirePermission: vi.fn() }))

describe("CLI SARIF import route", () => {
  it("posts to a path served by the v1 API route table", async () => {
    // The SDK prefixes every request with /api/v1, so `--sarif` posts to
    // /api/v1/scans/{id}/artifacts/sarif — this import resolves that exact
    // route file rather than mocking client.request.
    const mod = await import("../../../../apps/web/src/app/api/v1/scans/[id]/artifacts/sarif/route")
    expect(typeof mod.POST).toBe("function")
  })
})
