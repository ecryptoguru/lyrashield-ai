import { expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  getSharedLaunchReport: vi
    .fn()
    .mockResolvedValue({ payload: { verdictLabel: "Ready to launch", stale: false }, stale: true }),
}))
import { GET } from "./route"

it("does not render a historical READY as a passing badge", async () => {
  const response = await GET(new Request("https://example.test/badge?token=fixture"), {
    params: Promise.resolve({ reportId: "report-1" }),
  })
  const body = await response.text()
  expect(body).toContain("stale — re-run")
  expect(body).not.toContain("passing")
})
