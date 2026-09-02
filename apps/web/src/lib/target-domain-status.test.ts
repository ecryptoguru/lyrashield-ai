import { beforeEach, describe, expect, it, vi } from "vitest"
const { proofs, audits, rls } = vi.hoisted(() => ({
  proofs: vi.fn(),
  audits: vi.fn(),
  rls: vi.fn(),
}))
vi.mock("@lyrashield/db", () => ({ withWorkspaceRLS: rls }))
import { getTargetDomainStatuses } from "./target-domain-status"
describe("target domain status summaries", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    proofs.mockResolvedValue([])
    audits.mockResolvedValue([])
    rls.mockImplementation(async (_id, callback) =>
      callback({ targetDomainVerification: { findMany: proofs }, auditLog: { findMany: audits } })
    )
  })
  it("scopes minimal metadata to the workspace and page's normalized domains", async () => {
    const targets = [
      { id: "t1", type: "WEB_APP", url: "https://App.Example.com/path" },
      { id: "r1", type: "REPO", url: null },
    ]
    const result = await getTargetDomainStatuses("ws1", targets)
    expect(rls).toHaveBeenCalledWith("ws1", expect.any(Function))
    expect(proofs).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws1", domain: { in: ["app.example.com"] } },
        select: { domain: true, status: true, expiresAt: true },
      })
    )
    expect(audits).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "ws1", resourceId: { in: ["t1"] } }),
      })
    )
    expect(result.get("t1")).toBe("Not verified")
    expect(result.has("r1")).toBe(false)
  })
  it.each([
    ["VERIFIED", "2099-01-01", "Verified until 2099-01-01T00:00:00.000Z"],
    ["VERIFIED", "2000-01-01", "Not verified (expired)"],
    ["PENDING", "2099-01-01", "Self-attested"],
  ])("renders truthful %s state", async (status, expiresAt, expected) => {
    proofs.mockResolvedValue([{ domain: "example.com", status, expiresAt: new Date(expiresAt) }])
    audits.mockResolvedValue([{ resourceId: "t1" }])
    expect(
      (
        await getTargetDomainStatuses("ws1", [
          { id: "t1", type: "API", url: "https://example.com" },
        ])
      ).get("t1")
    ).toBe(expected)
  })
  it("skips proof lookups for repositories and invalid domains", async () => {
    await getTargetDomainStatuses("ws1", [{ id: "r1", type: "REPO", url: null }])
    expect(rls).not.toHaveBeenCalled()
  })
})
