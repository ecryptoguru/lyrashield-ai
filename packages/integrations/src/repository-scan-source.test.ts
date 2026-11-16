import { beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("./github", () => ({
  getBranchRefSha: vi.fn(),
  getDefaultBranch: vi.fn(),
  getMergeBaseSha: vi.fn(),
}))
import { getBranchRefSha, getDefaultBranch, getMergeBaseSha } from "./github"
import { resolveRepositoryScanSource } from "./repository-scan-source"

const target = {
  type: "REPO",
  workspaceId: "workspace",
  installationId: "123",
  repoFullName: "owner/repo",
  branch: "main",
}
const connection = {
  workspaceId: "workspace",
  type: "GITHUB",
  externalId: "123",
  status: "active",
  deletedAt: null,
}
const readActiveConnection = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  readActiveConnection.mockResolvedValue(connection)
  vi.mocked(getBranchRefSha).mockResolvedValue("A".repeat(40))
  vi.mocked(getDefaultBranch).mockResolvedValue("main")
})
describe("trusted immutable repository scan source", () => {
  it("binds the current workspace connection before resolving the stored branch", async () => {
    expect(await resolveRepositoryScanSource(target, { readActiveConnection })).toEqual({
      revision: "a".repeat(40),
    })
    expect(readActiveConnection.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(getBranchRefSha).mock.invocationCallOrder[0]!
    )
    expect(getBranchRefSha).toHaveBeenCalledWith(
      123,
      "owner",
      "repo",
      "main",
      expect.objectContaining({ retries: 0, signal: expect.any(AbortSignal) })
    )
  })
  it.each([
    null,
    { ...connection, status: "revoked" },
    { ...connection, workspaceId: "other" },
    { ...connection, externalId: "456" },
    { ...connection, deletedAt: new Date() },
    { ...connection, type: "GITLAB" },
  ])("rejects absent or mismatched active connection %j", async (value) => {
    readActiveConnection.mockResolvedValue(value)
    await expect(
      resolveRepositoryScanSource(target, { readActiveConnection })
    ).rejects.toMatchObject({ code: "SCAN_REF_UNRESOLVED" })
    expect(getBranchRefSha).not.toHaveBeenCalled()
  })
  it("resolves the default branch when none is stored", async () => {
    await resolveRepositoryScanSource({ ...target, branch: null }, { readActiveConnection })
    expect(getDefaultBranch).toHaveBeenCalledWith(123, "owner", "repo", expect.any(Object))
  })
  it.each(["short-sha", "refs/heads/main", ""])(
    "rejects nonimmutable provider revision %j",
    async (value) => {
      vi.mocked(getBranchRefSha).mockResolvedValue(value)
      await expect(resolveRepositoryScanSource(target, { readActiveConnection })).rejects.toThrow()
    }
  )
  it("fails closed on provider outage", async () => {
    vi.mocked(getBranchRefSha).mockRejectedValue(new Error("unreachable"))
    await expect(
      resolveRepositoryScanSource(target, { readActiveConnection })
    ).rejects.toMatchObject({ code: "SCAN_REF_UNRESOLVED" })
  })
  it("confirms a stored immutable ref through the authorized repository", async () => {
    vi.mocked(getMergeBaseSha).mockResolvedValue("b".repeat(40))
    await expect(
      resolveRepositoryScanSource({ ...target, branch: "b".repeat(40) }, { readActiveConnection })
    ).resolves.toEqual({ revision: "b".repeat(40) })
    vi.mocked(getMergeBaseSha).mockResolvedValue("c".repeat(40))
    await expect(
      resolveRepositoryScanSource({ ...target, branch: "b".repeat(40) }, { readActiveConnection })
    ).rejects.toThrow()
  })
  it("leaves URL and API scans free of repository network reads", async () => {
    for (const type of ["URL", "API"])
      expect(
        await resolveRepositoryScanSource({ ...target, type }, { readActiveConnection })
      ).toBeUndefined()
    expect(readActiveConnection).not.toHaveBeenCalled()
  })
})
