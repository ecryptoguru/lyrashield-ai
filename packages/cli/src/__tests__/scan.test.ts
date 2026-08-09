import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Output } from "../output.js"
import { handleScan } from "../commands/scan.js"
import { createClient } from "../client.js"
import { getEffectiveCredentials } from "../credentials.js"
import {
  findOrCreateRepoTarget,
  resolveRepoFromPath,
  loadDefaultProject,
  saveDefaultProject,
} from "../projects.js"

vi.mock("../client.js", () => ({
  createClient: vi.fn(),
}))

vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: vi.fn(),
  requireWorkspace: vi.fn((creds: { workspaceId: string }) => creds.workspaceId),
}))

vi.mock("../projects.js", () => ({
  findOrCreateRepoTarget: vi.fn(),
  resolveRepoFromPath: vi.fn(),
  loadDefaultProject: vi.fn(),
  saveDefaultProject: vi.fn(),
}))

const mockRepo = {
  repoProvider: "github",
  repoOwner: "ecryptoguru",
  repoName: "lyrashield-ai",
  repoFullName: "ecryptoguru/lyrashield-ai",
}

function makeOutput(): Output {
  return {
    json: false,
    quiet: false,
    log: vi.fn(),
    notice: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    result: vi.fn(),
    fail: vi.fn() as unknown as (error: string, exitCode?: number) => never,
  }
}

function getScanBody() {
  const call = (createClient as ReturnType<typeof vi.fn>).mock.results[0]
  if (!call) return undefined
  const client = call.value as { request: ReturnType<typeof vi.fn> }
  return client.request.mock.calls[0]?.[2] as { body?: Record<string, unknown> } | undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(getEffectiveCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
    apiKey: "lsk_test",
    workspaceId: "ws-current",
    apiUrl: "https://app.lyrashieldai.com",
  })
  ;(createClient as ReturnType<typeof vi.fn>).mockReturnValue({
    request: vi.fn().mockResolvedValue({ id: "s-123" }),
  })
})

describe("handleScan", () => {
  it("defaults to STANDARD mode for a general scan", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      workspaceId: "ws-current",
      targetId: "t-existing",
      name: "existing",
    })
    const output = makeOutput()
    const code = await handleScan(["--target", "t-existing"], output)
    expect(code).toBe(0)

    const body = getScanBody()?.body
    expect(body).toMatchObject({
      workspaceId: "ws-current",
      targetId: "t-existing",
      goal: "TEST_APP",
      mode: "STANDARD",
    })
  })

  it("respects an explicit mode", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const output = makeOutput()
    const code = await handleScan(["--target", "t-1", "--mode", "SAFE"], output)
    expect(code).toBe(0)

    const body = getScanBody()?.body
    expect(body).toMatchObject({ mode: "SAFE" })
  })

  it("auto-detects a repo and saves the current workspace", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(resolveRepoFromPath as ReturnType<typeof vi.fn>).mockResolvedValue({
      repo: mockRepo,
      cwd: "/tmp/repo",
    })
    ;(findOrCreateRepoTarget as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "t-123",
      name: "lyrashield-ai",
    })

    const output = makeOutput()
    const code = await handleScan(["--auto"], output)
    expect(code).toBe(0)

    expect(saveDefaultProject).toHaveBeenCalledWith({
      workspaceId: "ws-current",
      targetId: "t-123",
      name: "lyrashield-ai",
      repository: "ecryptoguru/lyrashield-ai",
    })

    const body = getScanBody()?.body
    expect(body).toMatchObject({ targetId: "t-123", mode: "STANDARD" })
  })

  it("ignores a stale default project from a different workspace", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      workspaceId: "ws-stale",
      targetId: "t-stale",
      name: "stale",
    })
    ;(resolveRepoFromPath as ReturnType<typeof vi.fn>).mockResolvedValue({
      repo: mockRepo,
      cwd: "/tmp/repo",
    })
    ;(findOrCreateRepoTarget as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "t-123",
      name: "lyrashield-ai",
    })

    const output = makeOutput()
    const code = await handleScan(["--auto"], output)
    expect(code).toBe(0)

    expect(saveDefaultProject).toHaveBeenCalledWith({
      workspaceId: "ws-current",
      targetId: "t-123",
      name: "lyrashield-ai",
      repository: "ecryptoguru/lyrashield-ai",
    })

    const body = getScanBody()?.body
    expect(body).toMatchObject({ targetId: "t-123" })
  })

  it("resolves a full git repo URL", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(findOrCreateRepoTarget as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "t-123",
      name: "lyrashield-ai",
    })

    const output = makeOutput()
    const code = await handleScan(
      ["--repo", "https://github.com/ecryptoguru/lyrashield-ai.git", "--name", "myproject"],
      output
    )
    expect(code).toBe(0)

    expect(findOrCreateRepoTarget).toHaveBeenCalledWith(
      expect.any(Object),
      "ws-current",
      mockRepo,
      "myproject"
    )
  })

  it("uses an explicit repo instead of a saved default project", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      workspaceId: "ws-current",
      targetId: "t-default",
      name: "default",
    })
    ;(findOrCreateRepoTarget as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "t-explicit",
      name: "lyrashield-ai",
    })

    const output = makeOutput()
    const code = await handleScan(["--repo", "ecryptoguru/lyrashield-ai"], output)

    expect(code).toBe(0)
    expect(findOrCreateRepoTarget).toHaveBeenCalledWith(
      expect.any(Object),
      "ws-current",
      mockRepo,
      undefined
    )
    expect(getScanBody()?.body).toMatchObject({ targetId: "t-explicit" })
  })

  it("rejects an invalid repo string", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const output = makeOutput()
    const code = await handleScan(["--repo", "not-a-repo"], output)
    expect(code).toBe(2)
    expect(output.error).toHaveBeenCalledWith("Invalid repo format: not-a-repo")
  })
})
