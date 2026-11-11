import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Target } from "@lyrashield/db"
import type { ScanSetupInput } from "./evidence"

const github = vi.hoisted(() => ({
  getDefaultBranch: vi.fn(),
  getBranchRefSha: vi.fn(),
  getMergeBaseSha: vi.fn(),
}))
vi.mock("@lyrashield/integrations", () => github)
import { readSetupSourceIdentity } from "./source-preflight"

const target: Target = {
  id: "target-1",
  workspaceId: "ws-1",
  projectId: null,
  type: "REPO",
  name: "Test project",
  url: null,
  apiSpecUrl: null,
  repoProvider: "github",
  repoOwner: "owner",
  repoName: "project",
  installationId: "123",
  repoFullName: "owner/project",
  branch: "feature",
  environment: "STAGING",
  status: "active",
  lastScanAt: null,
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}
const input: ScanSetupInput = {
  workspaceId: "ws-1",
  targetId: "target-1",
  goal: "TEST_APP",
  mode: "STANDARD",
  workflow: "REVIEW_CHANGES",
  baseRef: "main",
}
const connection = { id: "connection-1", status: "active" }
const head = "a".repeat(40)
const base = "b".repeat(40)
const mergeBase = "c".repeat(40)

describe("read-only setup source observation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    github.getDefaultBranch.mockResolvedValue("main")
    github.getBranchRefSha.mockImplementation(async (_id, _owner, _repo, ref) =>
      ref === "feature" ? head : base
    )
    github.getMergeBaseSha.mockResolvedValue(mergeBase)
  })

  it("binds immutable head, base and merge base observed under the active installation", async () => {
    expect(
      await readSetupSourceIdentity(target, input, connection, new AbortController().signal)
    ).toEqual({
      head,
      base,
      mergeBase,
    })
    expect(github.getMergeBaseSha).toHaveBeenCalledWith(123, "owner", "project", base, head, {
      signal: expect.any(AbortSignal),
      retries: 0,
    })
  })

  it("returns unavailable for missing connections, malformed revisions or provider failure", async () => {
    expect(await readSetupSourceIdentity(target, input, null, new AbortController().signal)).toBe(
      "UNAVAILABLE"
    )
    github.getBranchRefSha.mockResolvedValueOnce("not-a-sha")
    expect(
      await readSetupSourceIdentity(target, input, connection, new AbortController().signal)
    ).toBe("UNAVAILABLE")
    github.getBranchRefSha.mockRejectedValueOnce(new Error("provider unavailable"))
    expect(
      await readSetupSourceIdentity(target, input, connection, new AbortController().signal)
    ).toBe("UNAVAILABLE")
  })

  it("stops an aborted observation and does not continue to the base or merge lookup", async () => {
    let release: ((value: string) => void) | undefined
    github.getBranchRefSha.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )
    const controller = new AbortController()
    const pending = readSetupSourceIdentity(target, input, connection, controller.signal)
    controller.abort()
    expect(await pending).toBe("UNAVAILABLE")
    release?.(head)
    await Promise.resolve()
    expect(github.getBranchRefSha).toHaveBeenCalledTimes(1)
    expect(github.getMergeBaseSha).not.toHaveBeenCalled()
  })
})
