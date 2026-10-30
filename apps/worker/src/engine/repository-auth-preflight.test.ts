import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
const mocks = vi.hoisted(() => ({ integration: vi.fn(), token: vi.fn(), rls: vi.fn() }))
vi.mock("@lyrashield/db", () => ({ withWorkspaceRLS: mocks.rls }))
vi.mock("@lyrashield/integrations", () => ({ getRepositoryReadToken: mocks.token }))
import { prepareRepositoryAuth } from "./repository-auth"
const target = {
  type: "REPO",
  repoProvider: "github",
  repoFullName: "owner/private",
  installationId: "123",
}
const token = randomUUID()
const input = () => ({
  workspaceId: "workspace-1",
  target,
  scanRuntimeBudgetMs: 30_000,
  elapsedScanMs: () => 0,
  isScanCancelled: vi.fn().mockResolvedValue(false),
})
beforeEach(() => {
  vi.resetAllMocks()
  mocks.rls.mockImplementation((_workspace, fn) =>
    fn({ integration: { findFirst: mocks.integration } })
  )
  mocks.integration.mockResolvedValue({ id: "integration-1" })
  mocks.token.mockResolvedValue(token)
})
afterEach(() => vi.useRealTimers())
describe("private repository authorization before the billable boundary", () => {
  it("checks the active integration in the exact workspace before minting a token", async () => {
    expect(await prepareRepositoryAuth(input())).toEqual({
      repoFullName: target.repoFullName,
      token,
    })
    expect(mocks.rls).toHaveBeenCalledWith("workspace-1", expect.any(Function))
    expect(mocks.integration).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        type: "GITHUB",
        externalId: "123",
        status: "active",
        deletedAt: null,
      },
      select: { id: true },
    })
    expect(mocks.token).toHaveBeenCalledWith(123, "owner/private")
    expect(mocks.integration.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.token.mock.invocationCallOrder[0]!
    )
  })
  it("refuses a missing or inactive workspace integration", async () => {
    mocks.integration.mockResolvedValue(null)
    await expect(prepareRepositoryAuth(input())).rejects.toThrow("integration is unavailable")
    expect(mocks.token).not.toHaveBeenCalled()
  })
  it("rejects revocation recorded while the checkout token is being minted", async () => {
    mocks.integration.mockResolvedValueOnce({ id: "integration-1" }).mockResolvedValueOnce(null)
    await expect(prepareRepositoryAuth(input())).rejects.toThrow("integration is unavailable")
  })
  it("rejects an integration replacement recorded while minting", async () => {
    mocks.integration
      .mockResolvedValueOnce({ id: "integration-1" })
      .mockResolvedValueOnce({ id: "integration-2" })
    await expect(prepareRepositoryAuth(input())).rejects.toThrow("integration is unavailable")
  })
  it("does not obtain credentials for public or URL targets", async () => {
    for (const candidate of [
      { ...target, installationId: null },
      { ...target, type: "WEB_APP" },
    ])
      expect(await prepareRepositoryAuth({ ...input(), target: candidate })).toBeUndefined()
    expect(mocks.token).not.toHaveBeenCalled()
    expect(mocks.rls).not.toHaveBeenCalled()
  })
  it.each([
    { ...target, installationId: "abc" },
    { ...target, repoProvider: "other" },
    { ...target, repoFullName: "owner/../private" },
  ])("rejects invalid stored source identity before a provider request", async (target) => {
    await expect(prepareRepositoryAuth({ ...input(), target })).rejects.toThrow()
    expect(mocks.token).not.toHaveBeenCalled()
  })
  it("bounds a hanging token request by remaining scan time", async () => {
    vi.useFakeTimers()
    mocks.token.mockReturnValue(new Promise(() => {}))
    const result = prepareRepositoryAuth({ ...input(), scanRuntimeBudgetMs: 100 }).catch(
      (error) => error
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toMatchObject({ message: "Repository authorization deadline exhausted" })
    expect(vi.getTimerCount()).toBe(0)
  })
  it("stops a hanging token request when cancellation is recorded", async () => {
    vi.useFakeTimers()
    mocks.token.mockReturnValue(new Promise(() => {}))
    const isCancelled = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const result = prepareRepositoryAuth({ ...input(), isScanCancelled: isCancelled }).catch(
      (error) => error
    )
    await vi.advanceTimersByTimeAsync(250)
    expect(await result).toMatchObject({ message: "Repository authorization cancelled" })
    expect(vi.getTimerCount()).toBe(0)
  })
})
