import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  claimArtifactDeletionTask: mocks.claim,
  completeArtifactDeletionTask: mocks.complete,
  failArtifactDeletionTask: mocks.fail,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

const { drainArtifactDeletionTasksWith } = await import("./deletion-drain")

function task(index: number, attempts = 1) {
  return {
    id: `task-${index}`,
    workspaceId: "workspace-1",
    kind: "EVIDENCE",
    storageUri: `s3://evidence/evidence/workspace-1/${index}.enc`,
    status: "PROCESSING",
    attempts,
    nextAttemptAt: new Date(),
    leaseToken: `lease-${index}`,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

describe("artifact deletion drain", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.complete.mockResolvedValue(true)
    mocks.fail.mockResolvedValue("retry")
  })

  it("deletes a claimed artifact and completes its durable task", async () => {
    mocks.claim.mockResolvedValueOnce(task(1)).mockResolvedValueOnce(null)
    const deleteArtifact = vi.fn().mockResolvedValue(undefined)

    await expect(drainArtifactDeletionTasksWith(deleteArtifact)).resolves.toEqual({
      claimed: 1,
      deleted: 1,
      retrying: 0,
      deadLettered: 0,
    })
    expect(deleteArtifact).toHaveBeenCalledWith(
      "s3://evidence/evidence/workspace-1/1.enc",
      "workspace-1"
    )
    expect(mocks.complete).toHaveBeenCalledWith("task-1", "lease-1")
  })

  it("keeps a failed deletion durable and succeeds on a later sweep", async () => {
    const firstClaim = task(1)
    mocks.claim.mockResolvedValueOnce(firstClaim).mockResolvedValueOnce(null)
    const deleteArtifact = vi.fn().mockRejectedValueOnce(new Error("object store unavailable"))

    await expect(drainArtifactDeletionTasksWith(deleteArtifact)).resolves.toMatchObject({
      claimed: 1,
      retrying: 1,
      deleted: 0,
    })
    expect(mocks.fail).toHaveBeenCalledWith(firstClaim, expect.any(Error))

    mocks.claim.mockResolvedValueOnce(task(1, 2)).mockResolvedValueOnce(null)
    deleteArtifact.mockResolvedValueOnce(undefined)
    await expect(drainArtifactDeletionTasksWith(deleteArtifact)).resolves.toMatchObject({
      claimed: 1,
      deleted: 1,
    })
  })

  it("processes more than one bounded batch across recurring sweeps", async () => {
    const pending = Array.from({ length: 101 }, (_, index) => task(index + 1))
    mocks.claim.mockImplementation(async () => pending.shift() ?? null)
    const deleteArtifact = vi.fn().mockResolvedValue(undefined)

    const first = await drainArtifactDeletionTasksWith(deleteArtifact, { limit: 100 })
    const second = await drainArtifactDeletionTasksWith(deleteArtifact, { limit: 100 })

    expect(first).toMatchObject({ claimed: 100, deleted: 100 })
    expect(second).toMatchObject({ claimed: 1, deleted: 1 })
    expect(deleteArtifact).toHaveBeenCalledTimes(101)
  })
})
